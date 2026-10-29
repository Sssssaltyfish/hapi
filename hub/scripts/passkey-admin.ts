import { passkeyStore } from '../src/passkeys/config'

const store = passkeyStore()
try {
    const action = process.argv[2]
    if (action === 'pair') {
        const result = store.issueCode()
        console.log(`一次性配对码: ${result.code}\n有效期至: ${new Date(result.expiresAt).toISOString()}（10 分钟）`)
    } else if (action === 'list') {
        console.log(JSON.stringify(store.credentials().map(({ id, name, createdAt }) => ({ id, name, createdAt })), null, 2))
    } else if (action === 'revoke' && process.argv[3]) {
        console.log(JSON.stringify({ revoked: store.revoke(process.argv[3]) }))
    } else throw new Error('Usage: passkey-admin.ts pair | list | revoke <credential-id>')
} finally { store.close() }
