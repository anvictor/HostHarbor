import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// CDP is enabled only by this test launcher, bound to loopback, and removed on exit.
const port=Number(process.env.HOSTHARBOR_TEST_PORT || 19233);
const {spawn}=await import('node:child_process');
const {default:electron}=await import('electron');
const smokeProfile=await fs.mkdtemp(process.cwd()+'/.tools/ui-smoke-');
const executable=process.env.HOSTHARBOR_TEST_EXECUTABLE || electron;
const processUnderTest=spawn(executable,['.','--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`],{cwd:process.cwd(),env:{...process.env,HOSTHARBOR_USER_DATA:smokeProfile,HOSTHARBOR_TEST_MODE:'1'},stdio:['ignore','pipe','pipe']});
let diagnostics='';processUnderTest.stderr.on('data',chunk=>{diagnostics+=chunk.toString()});
process.on('exit',()=>processUnderTest.kill());
let targets;
for(let attempt=0;attempt<200;attempt++){
 try{targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();if(targets.some(t=>t.url.endsWith('/renderer/index.html')))break}catch{}
 if(processUnderTest.exitCode!==null)throw Error('App exited: '+diagnostics);
 await new Promise(r=>setTimeout(r,100));
}
assert(targets,'App debug target startup: '+diagnostics);
const target = targets.find(t=>t.type==='page' && t.url.endsWith('/renderer/index.html'));
assert(target,'App renderer target exists');
let ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
assert.equal(await evaluate('typeof window.require'),'undefined');
assert.equal(await evaluate('typeof window.harbor.bootstrap'),'function');
for(let i=0;i<100;i++){if(await evaluate("document.getElementById('activity-label').textContent==='Готово до роботи'"))break;await new Promise(r=>setTimeout(r,50));}
const bootstrap=await evaluate('window.harbor.bootstrap()');assert(bootstrap.ok);assert(bootstrap.value.secretStorageAvailable);
// A second launch with the same userData must exit and focus the first window.
const second=spawn(executable,['.'],{cwd:process.cwd(),env:{...process.env,HOSTHARBOR_USER_DATA:smokeProfile,HOSTHARBOR_TEST_MODE:'1'},stdio:'ignore'});
const secondExit=await Promise.race([new Promise(resolve=>second.on('exit',resolve)),new Promise((_,reject)=>{const timer=setTimeout(()=>{second.kill();reject(Error('Second instance did not exit'))},10000);timer.unref()})]);
assert.equal(secondExit,0,'Second launch exits normally');
assert.equal(processUnderTest.exitCode,null,'First instance remains alive');
assert.equal(await evaluate('typeof window.harbor.bootstrap'),'function');

const fixture=await fs.mkdtemp('/private/tmp/hostharbor-ui-');await fs.writeFile(fixture+'/sample.txt','HostHarbor smoke fixture');
await evaluate(`document.getElementById('local-path').value=${JSON.stringify(fixture)};document.getElementById('local-path-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
for(let i=0;i<100;i++){if(await evaluate("document.getElementById('local-files').textContent.includes('sample.txt')"))break;await new Promise(r=>setTimeout(r,50));}
assert(await evaluate("document.getElementById('local-files').textContent.includes('sample.txt')"),'Local navigation displays fixture');
await evaluate("document.getElementById('profile-dialog').close();document.getElementById('add-profile').click()");assert(await evaluate("document.getElementById('profile-dialog').open"));
const fields={'profile-name':'Smoke test','profile-host':'127.0.0.1','profile-username':'test','profile-port':'22'};
for(const [key,value]of Object.entries(fields))await evaluate(`document.getElementById(${JSON.stringify(key)}).value=${JSON.stringify(value)}`);
await evaluate("document.getElementById('save-profile').click()");
for(let i=0;i<100;i++){if(!await evaluate("document.getElementById('profile-dialog').open"))break;await new Promise(r=>setTimeout(r,50));}

assert(!await evaluate("document.getElementById('profile-dialog').open"),'Profile dialog saves without connect');
assert(await evaluate("document.getElementById('profiles').textContent.includes('Smoke test')"));
const profiles=await evaluate('window.harbor.bootstrap()');assert(profiles.value.profiles.some(p=>p.name==='Smoke test'));
await evaluate("document.getElementById('dismiss-notice').click()");
// Refused local SSH connection must be actionable and retain a collapsed diagnostic.
const {createServer}=await import('node:net');
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const closedPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
await evaluate("document.querySelector('.profile-main').click()");
await evaluate(`document.getElementById('profile-port').value=${closedPort};document.getElementById('profile-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
for(let attempt=0;attempt<100;attempt++){if(await evaluate("!document.getElementById('profile-error').hidden"))break;await new Promise(resolve=>setTimeout(resolve,50));}
assert.match(await evaluate("document.getElementById('profile-error').textContent"),/З’єднання відхилено/);
assert.equal(await evaluate("document.getElementById('profile-error-details').hidden"),false);
assert.equal(await evaluate("document.getElementById('profile-error-details').open"),false);
assert.match(await evaluate("document.querySelector('#profile-error-details pre').textContent"),/ECONNREFUSED/);
await fs.mkdir(process.cwd()+'/artifacts',{recursive:true});
const errorShot=await send('Page.captureScreenshot',{format:'png'});
await fs.writeFile(process.cwd()+'/artifacts/connection-error.png',Buffer.from(errorShot.data,'base64'));
await evaluate("document.getElementById('close-profile').click();document.getElementById('add-profile').click()");
assert.equal(await evaluate("document.getElementById('profile-error-details').hidden"),true);
assert.equal(await evaluate("document.querySelector('#profile-error-details pre').textContent"),'');
await evaluate("document.getElementById('close-profile').click()");

await fs.mkdir(process.cwd()+'/artifacts',{recursive:true});
const shot=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(process.cwd()+'/artifacts/desktop-smoke.png',Buffer.from(shot.data,'base64'));
await send('Page.close');
ws.close();
const relaunch=spawn(executable,['.'],{cwd:process.cwd(),env:{...process.env,HOSTHARBOR_USER_DATA:smokeProfile,HOSTHARBOR_TEST_MODE:'1'},stdio:'ignore'});
assert.equal(await Promise.race([new Promise(resolve=>relaunch.on('exit',resolve)),new Promise((_,reject)=>{const timer=setTimeout(()=>{relaunch.kill();reject(Error('Relaunch did not exit'))},10000);timer.unref()})]),0);
let reopened=[];
for(let attempt=0;attempt<100;attempt++){
 reopened=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t=>t.type==='page'&&t.url.endsWith('/renderer/index.html'));
 if(reopened.length)break;
 await new Promise(resolve=>setTimeout(resolve,50));
}
assert.equal(reopened.length,1,'Relaunch after closing the last window recreates exactly one window');
ws=new WebSocket(reopened[0].webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}};
let ready=false;
for(let attempt=0;attempt<100;attempt++){
 ready=await evaluate("document.readyState==='complete' && typeof window.harbor?.bootstrap==='function' && document.getElementById('activity-label')?.textContent==='Готово до роботи'");
 if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));
}
assert(ready,'Reopened renderer completely loads before test shutdown');
const finished=new Promise(resolve=>processUnderTest.once('exit',resolve));
void send('Browser.close').catch(()=>{});
await Promise.race([finished,new Promise((_,reject)=>{const timer=setTimeout(()=>{processUnderTest.kill('SIGKILL');reject(Error('App did not quit cleanly'))},5000);timer.unref()})]);

console.log(JSON.stringify({friendlyConnectionErrors:true,singleInstance:true,reopenAfterClose:true,rendererLoaded:true,nodeIntegrationDisabled:true,localNavigation:true,profileSaved:true,osEncryptionAvailable:bootstrap.value.secretStorageAvailable,screenshot:'artifacts/desktop-smoke.png'}));ws.close();await fs.rm(fixture,{recursive:true,force:true});
