import { env } from 'cloudflare:workers';
import { advance, applyInput, cancelRace, createRace, publicView, RaceRuleError, type RaceInput, type RaceState, type PlayerId } from '../../../../lib/race-engine';
export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
class HttpError extends Error { constructor(message:string, public status=400){super(message);} }
type Row = {id:string;state:string;version:number;expires_at:number;red_hash:string;blue_hash:string};
function db(){if(!env.DB)throw new HttpError('Database unavailable',503);return env.DB;}
function bucket(){if(!env.BUCKET)throw new HttpError('Image storage unavailable',503);return env.BUCKET;}
function secret(){const key=(env as Record<string,unknown>).RACE_ADMIN_KEY;if(typeof key!=='string'||!key)throw new HttpError('Operator is not configured',503);return key;}
const bearer = (r:Request) => r.headers.get('authorization')?.replace(/^Bearer /,'') || '';
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function requireAdmin(r:Request){if(!bearer(r)||await hash(bearer(r))!==await hash(secret()))throw new HttpError('Operator authentication required',401);}
function player(value:unknown):PlayerId{if(value!=='red'&&value!=='blue')throw new HttpError('Invalid player');return value;}
function validId(value:string){if(!/^race_[a-f0-9]{32}$/.test(value))throw new HttpError('Race not found',404);return value;}
async function row(id:string){const found=await db().prepare('SELECT * FROM races WHERE id = ?').bind(validId(id)).first<Row>();if(!found)throw new HttpError('Race not found',404);return found;}
async function body(r:Request){const text=await r.text();if(text.length>8192)throw new HttpError('Request too large',413);try{const data=JSON.parse(text);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}catch{throw new HttpError('Invalid JSON');}}
async function view(found:Row){
 const state=publicView(advance(JSON.parse(found.state) as RaceState,Date.now()));
 const records=await db().prepare('SELECT player,status,session_id,actions,frame_at FROM race_telemetry WHERE race_id = ?').bind(found.id).all<{player:PlayerId;status:string;session_id:string|null;actions:number;frame_at:number|null}>();
 const telemetry:Record<string,unknown>={};for(const r of records.results)telemetry[r.player]={status:r.status,sessionId:r.session_id ? r.session_id.slice(-8) : null,actions:r.actions,frameAt:r.frame_at};
 return {state,telemetry};
}
async function mutate(id:string,fn:(s:RaceState,r:Row)=>Promise<RaceState>|RaceState){
 for(let attempt=0;attempt<6;attempt++){const found=await row(id);const next=await fn(JSON.parse(found.state),found);const result=await db().prepare('UPDATE races SET state = ?, version = version + 1 WHERE id = ? AND version = ?').bind(JSON.stringify(next),id,found.version).run();if(result.meta.changes)return view({...found,state:JSON.stringify(next),version:found.version+1});}
 throw new HttpError('Another control arrived at the same time. Please retry.',409);
}
async function handle(request:Request,context:{params:Promise<{path?:string[]}>}){
 const {path=[]}=await context.params;
 if(request.method==='GET'){
  if(path.length===1&&path[0]==='latest'){const latest=await db().prepare('SELECT id FROM races ORDER BY created_at DESC LIMIT 1').first<{id:string}>();return json({id:latest?.id||null});}
  const id=validId(path[0]||'');const found=await row(id);
  if(path.length===1)return json(await view(found));
  if(path.length===3&&path[1]==='frame'){const p=player(path[2]);const image=await bucket().get(`${id}/${p}`);if(!image)throw new HttpError('No screenshot yet',404);return new Response(image.body,{headers:{'Content-Type':image.httpMetadata?.contentType||'image/jpeg','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});}
  throw new HttpError('Not found',404);
 }
 if(path.length===0){
  await requireAdmin(request);const input=await body(request);const now=Date.now();const id='race_'+crypto.randomUUID().replaceAll('-','');
  const token=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b=>b.toString(16).padStart(2,'0')).join('');const red=token(),blue=token();
  const state=createRace(String(input.seed||id).slice(0,100),now);
  await db().batch([
   db().prepare('INSERT INTO races (id,created_at,expires_at,version,state,red_hash,blue_hash) VALUES (?,?,?,?,?,?,?)').bind(id,now,now+30*60*1000,0,JSON.stringify(state),await hash(red),await hash(blue)),
   db().prepare('INSERT INTO race_telemetry (id,race_id,player,status,actions) VALUES (?,?,?,?,?)').bind(id+'red',id,'red','接続待ち',0),
   db().prepare('INSERT INTO race_telemetry (id,race_id,player,status,actions) VALUES (?,?,?,?,?)').bind(id+'blue',id,'blue','接続待ち',0),
  ]);
  const origin=new URL(request.url).origin;
  return json({id,playerUrls:{red:`${origin}/play/${id}/red#${red}`,blue:`${origin}/play/${id}/blue#${blue}`},spectatorUrl:`${origin}/race/${id}`},201);
 }
 const id=validId(path[0]||'');
 if(path.length===2&&path[1]==='input'){
  const input=await body(request);const p=player(input.player);const token=bearer(request);if(!token)throw new HttpError('Player authentication required',401);
  const digest=await hash(token);
  const result=await mutate(id,(state,found)=>{if(found.expires_at<Date.now())throw new HttpError('Player link expired',410);if(digest!==found[p==='red'?'red_hash':'blue_hash'])throw new HttpError('Wrong player link',403);return applyInput(state,p,input.input as RaceInput,Date.now());});return json(result);
 }
 await requireAdmin(request);await row(id);
 if(path.length===2&&path[1]==='stop'){return json(await mutate(id,s=>cancelRace(s,Date.now())));}
 if(path.length===2&&path[1]==='telemetry'){
  const data=await body(request);const p=player(data.player);await db().prepare('UPDATE race_telemetry SET status = ?, session_id = COALESCE(?,session_id), actions = MAX(actions,?) WHERE race_id = ? AND player = ?').bind(String(data.status||'実行中').slice(0,100),typeof data.sessionId==='string'?data.sessionId.slice(0,120):null,Math.max(0,Math.min(10000,Number(data.actions)||0)),id,p).run();return json({ok:true});
 }
 if(path.length===3&&path[1]==='frame'){
  const p=player(path[2]);const type=request.headers.get('content-type')?.split(';')[0];if(!type||!['image/jpeg','image/png','image/webp'].includes(type))throw new HttpError('Unsupported image',415);
  if(Number(request.headers.get('content-length'))>4*1024*1024)throw new HttpError('Image too large',413);const bytes=await request.arrayBuffer();if(bytes.byteLength>4*1024*1024)throw new HttpError('Image too large',413);
  const at=Date.now();await bucket().put(`${id}/${p}`,bytes,{httpMetadata:{contentType:type}});await db().prepare('UPDATE race_telemetry SET frame_at = ? WHERE race_id = ? AND player = ?').bind(at,id,p).run();return json({ok:true,frameAt:at});
 }
 throw new HttpError('Not found',404);
}
async function route(request:Request,context:{params:Promise<{path?:string[]}>}){try{return await handle(request,context);}catch(error){return json({error:error instanceof Error?error.message:'Request failed'},error instanceof HttpError?error.status:error instanceof RaceRuleError?409:500);}}
export const GET=route;
export const POST=route;
