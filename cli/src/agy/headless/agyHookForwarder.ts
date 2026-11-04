import { request } from 'node:http';

/** Internal child-process endpoint for the documented AGY lifecycle hooks. */
export async function runAgyHookForwarder(args: string[]): Promise<void> {
    const event = args[0];
    const port = Number(process.env.HAPI_AGY_HOOK_PORT);
    const token = process.env.HAPI_AGY_HOOK_TOKEN;
    const generation = process.env.HAPI_AGY_HOOK_GENERATION;
    if (!['pre', 'post'].includes(event) || !Number.isInteger(port) || port < 1 || port > 65535 || !token || !generation) {
        process.stdout.write('{}');
        return;
    }
    try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > 512 * 1024) throw new Error('AGY hook payload is too large');
            chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const output = await new Promise<string>((resolve) => {
            const req = request({ host: '127.0.0.1', port, method: 'POST', path: `/agy-hook/${event}`,
                headers: { 'x-hapi-hook-token': token, 'x-hapi-hook-generation': generation,
                    'content-type': 'application/json', 'content-length': body.length } }, response => {
                const received: Buffer[] = [];
                let length = 0;
                response.on('data', chunk => {
                    length += chunk.length;
                    if (length > 2 * 1024 * 1024) response.destroy();
                    else received.push(Buffer.from(chunk));
                });
                response.on('end', () => resolve(response.statusCode === 200 ? Buffer.concat(received).toString('utf8') : '{}'));
                response.on('error', () => resolve('{}'));
            });
            req.setTimeout(3000, () => { req.destroy(); resolve('{}'); });
            req.on('error', () => resolve('{}'));
            req.end(body);
        });
        const parsed = JSON.parse(output);
        process.stdout.write(JSON.stringify(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}));
    } catch {
        // A missing bridge leaves the native turn running. The parent owns the
        // reservation and will reconcile an unconfirmed delivery on turn close.
        process.stdout.write('{}');
    }
}
