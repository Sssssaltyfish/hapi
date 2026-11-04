import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { WebAuthnCredential } from '@simplewebauthn/server'

export type Credential = { id: string; key: string; counter: number; transports: string; name: string; userHandle: string; createdAt: number }
export type Challenge = { id: string; challenge: string; kind: string; pairingHash: string | null; userHandle: string | null; expires: number }
export const hashCode = (value: string) => createHash('sha256').update(value.trim().replace(/-/g, '').toUpperCase()).digest('hex')

export class PasskeyStore {
    readonly db: Database
    constructor(path: string, readonly sharedUserId?: string) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        this.db = new Database(path, { create: true })
        if (path !== ':memory:') chmodSync(path, 0o600)
        this.db.exec(`PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS pairing(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL,
                pairingHash TEXT, userHandle TEXT, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, key TEXT NOT NULL, counter INTEGER NOT NULL,
                transports TEXT NOT NULL, name TEXT NOT NULL, userHandle TEXT NOT NULL, createdAt INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, credentialId TEXT NOT NULL, expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS termix_credential_meta(credentialId TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL,
                userId TEXT NOT NULL, deviceType TEXT, backedUp INTEGER NOT NULL DEFAULT 0,
                userVerification TEXT NOT NULL DEFAULT 'required', lastUsedAt TEXT);`)
    }
    close() { this.db.close() }
    issueCode(now = Date.now()) {
        const code = randomBytes(10).toString('hex').toUpperCase().match(/.{1,4}/g)!.join('-')
        this.db.transaction(() => {
            this.db.exec('DELETE FROM pairing')
            this.db.query('INSERT INTO pairing VALUES (?, ?)').run(hashCode(code), now + 600_000)
        })()
        return { code, expiresAt: now + 600_000 }
    }
    validPairing(hash: string, now = Date.now()): boolean {
        return !!this.db.query('SELECT hash FROM pairing WHERE hash = ? AND expires > ?').get(hash, now)
    }
    saveChallenge(challenge: string, kind: 'register' | 'login', pairingHash?: string, userHandle?: string) {
        const now = Date.now()
        this.db.query('DELETE FROM challenges WHERE expires <= ?').run(now)
        this.db.query('DELETE FROM sessions WHERE expires <= ?').run(now)
        const count = this.db.query('SELECT COUNT(*) AS n FROM challenges').get() as { n: number }
        if (count.n >= 200) throw new Error('Too many pending challenges')
        const id = randomBytes(32).toString('base64url')
        this.db.query('INSERT INTO challenges VALUES (?, ?, ?, ?, ?, ?)').run(id, challenge, kind, pairingHash ?? null, userHandle ?? null, now + 300_000)
        return id
    }
    takeChallenge(id: string, kind: string): Challenge | null {
        // Atomic consumption prevents replay even when verification is asynchronous.
        return this.db.query('DELETE FROM challenges WHERE id = ? AND kind = ? AND expires > ? RETURNING *').get(id, kind, Date.now()) as Challenge | null
    }
    credentials(): Credential[] {
        return (this.sharedUserId
            ? this.db.query('SELECT c.* FROM credentials c JOIN termix_credential_meta m ON m.credentialId=c.id WHERE m.userId=? ORDER BY c.createdAt').all(this.sharedUserId)
            : this.db.query('SELECT * FROM credentials ORDER BY createdAt').all()) as Credential[]
    }
    credential(id: string): Credential | null {
        return (this.sharedUserId
            ? this.db.query('SELECT c.* FROM credentials c JOIN termix_credential_meta m ON m.credentialId=c.id WHERE c.id=? AND m.userId=?').get(id,this.sharedUserId)
            : this.db.query('SELECT * FROM credentials WHERE id = ?').get(id)) as Credential | null
    }
    register(pairingHash: string, credential: WebAuthnCredential, name: string, userHandle: string,
        metadata?: { deviceType: string; backedUp: boolean }) {
        this.db.transaction(() => {
            const consumed = this.db.query('DELETE FROM pairing WHERE hash = ? AND expires > ?').run(pairingHash, Date.now())
            if (consumed.changes !== 1) throw new Error('Pairing code expired or already used')
            this.db.query('INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?, ?)').run(credential.id,
                Buffer.from(credential.publicKey).toString('base64url'), credential.counter,
                JSON.stringify(credential.transports ?? []), name, userHandle, Date.now())
            if (this.sharedUserId) {
                if (userHandle !== Buffer.from(this.sharedUserId).toString('base64url')) throw new Error('Wrong shared account')
                this.db.query('INSERT INTO termix_credential_meta VALUES (?, ?, ?, ?, ?, ?, NULL)').run(credential.id,
                    randomUUID(), this.sharedUserId, metadata?.deviceType ?? 'singleDevice', metadata?.backedUp ? 1 : 0, 'required')
            }
        })()
    }
    updateCounter(id: string, previous: number, next: number): boolean {
        if (!this.credential(id)) return false
        return this.db.query('UPDATE credentials SET counter = ? WHERE id = ? AND counter = ? AND ? >= counter').run(next, id, previous, next).changes === 1
    }
    createSession(credentialId: string) {
        const id = randomBytes(32).toString('base64url')
        const expiresAt = Date.now() + 4 * 60 * 60_000
        this.db.query('INSERT INTO sessions VALUES (?, ?, ?)').run(id, credentialId, expiresAt)
        return { id, expiresAt }
    }
    hasSession(id: string): boolean {
        return !!this.db.query('SELECT s.id FROM sessions s JOIN credentials c ON c.id = s.credentialId WHERE s.id = ? AND s.expires > ?').get(id, Date.now())
    }
    logout(id: string) { this.db.query('DELETE FROM sessions WHERE id = ?').run(id) }
    revoke(id: string) {
        return this.db.transaction(() => {
            if (!this.credential(id)) return 0
            this.db.query('DELETE FROM sessions WHERE credentialId = ?').run(id)
            this.db.query('DELETE FROM termix_credential_meta WHERE credentialId = ?').run(id)
            return this.db.query('DELETE FROM credentials WHERE id = ?').run(id).changes
        })()
    }
}
