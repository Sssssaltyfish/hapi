import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PasskeyStore, hashCode } from './store'

test('Termix and HAPI share credentials, counters, ownership and revocation without resurrection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-passkeys-'))
    const file = join(dir, 'keys.sqlite')
    const module = fileURLToPath(new URL('../../../../shared-termix-repository.mjs', import.meta.url))
    const owner = 'owner-test'
    const legacy = { id:'termix-record',userId:owner,name:'Original key',credentialId:'original',publicKey:'AQID',counter:0,transports:'[]' }
    function termix(code: string) {
        const script = `import { sharedTermixRepository } from ${JSON.stringify(module)};
          const db={client:async()=>({select:()=>({from:async()=>[${JSON.stringify(legacy)}]})})};
          const repo=sharedTermixRepository(db,{}, {}, ${JSON.stringify(file)});
          try { await repo.ready; ${code} } finally { repo.close(); }`
        const result = spawnSync('node',['--input-type=module','-e',script],{encoding:'utf8'})
        if (result.status !== 0) throw new Error(result.stderr)
        return JSON.parse(result.stdout || 'null')
    }
    let store: PasskeyStore | undefined
    try {
        expect(termix(`console.log(JSON.stringify((await repo.listByUserId('${owner}')).length))`)).toBe(1)
        store = new PasskeyStore(file, owner)
        expect(store.credential('original')?.userHandle).toBe(Buffer.from(owner).toString('base64url'))
        const foreign = new PasskeyStore(file, 'another-owner')
        expect(foreign.credential('original')).toBeNull()
        expect(foreign.revoke('original')).toBe(0)
        foreign.close()
        const {code} = store.issueCode()
        store.register(hashCode(code),{id:'from-hapi',publicKey:new Uint8Array([1,2,3]),counter:0},'HAPI key',Buffer.from(owner).toString('base64url'),{deviceType:'multiDevice',backedUp:true})
        expect(termix(`console.log(JSON.stringify((await repo.findByCredentialId('from-hapi')).backedUp))`)).toBe(true)
        termix(`const key=await repo.findByCredentialId('from-hapi'); await repo.updateAuthState(key.id,{counter:2,deviceType:'multiDevice',backedUp:true,lastUsedAt:new Date().toISOString()});`)
        expect(store.credential('from-hapi')?.counter).toBe(2)
        expect(store.updateCounter('from-hapi',0,1)).toBe(false)
        expect(store.updateCounter('from-hapi',2,3)).toBe(true)
        expect(termix(`const key=await repo.findByCredentialId('from-hapi'); let rejected=false; try { await repo.updateAuthState(key.id,{counter:2,deviceType:'multiDevice',backedUp:true,lastUsedAt:new Date().toISOString()}); } catch {rejected=true;} console.log(JSON.stringify(rejected));`)).toBe(true)
        const session = store.createSession('from-hapi')
        termix(`const key=await repo.findByCredentialId('from-hapi'); await repo.deleteForUser('${owner}',key.id);`)
        expect(store.hasSession(session.id)).toBe(false)
        expect(store.credential('from-hapi')).toBeNull()
        expect(store.revoke('original')).toBe(1)
        // Reopening the Termix adapter must not import revoked legacy credentials again.
        expect(termix(`console.log(JSON.stringify((await repo.listByUserId('${owner}')).length))`)).toBe(0)
    } finally {store?.close(); rmSync(dir,{recursive:true,force:true})}
})
