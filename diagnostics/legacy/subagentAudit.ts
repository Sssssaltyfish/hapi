import { CodexAppServerClient } from '../codexAppServerClient';
import { initializeSharedClient } from './launch';
import { record } from './gateway';
import { readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
const settings = await readSettings();
configuration._setCliApiToken(settings.cliApiToken!);
const api = await ApiClient.create();
const client = new CodexAppServerClient({endpoint: process.env.HAPI_CODEX_EXTERNAL_ENDPOINT});
client.setServerRequestHandler(() => {});
await initializeSharedClient(client);
try {
 const sessions = await api.listResumableSessions(settings.machineId);
 const sources: Record<string, number> = {};
 const examples: unknown[] = [];
 for (const s of sessions.filter(s => s.flavor === 'codex' && s.agentSessionId)) {
  try {
   const t = record(record(await client.request('thread/read', {threadId:s.agentSessionId,includeTurns:false})).thread);
   const key=JSON.stringify(t.source);
   sources[key]=(sources[key]||0)+1;
   if(examples.length<12 && (typeof t.source!=='string' || /agent/i.test(t.source))) examples.push({sessionId:s.sessionId,active:s.active,threadId:t.id,source:t.source,keys:Object.keys(t),parentThreadId:t.parentThreadId});
  } catch(e) {console.error(String(e));}
 }
 console.log(JSON.stringify({count:sessions.length,sources,examples},null,2));
} finally {await client.disconnect();}
