// Runs only in an Argo-created private staging directory received over authenticated SSH.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

const stage=resolve(process.argv[2]||'.');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<13))throw new Error('Argo requires Node.js 22.13 or later on the remote host. No system packages were changed.');
const setup=JSON.parse(readFileSync(join(stage,'remote-setup.json'),'utf8'));
if(!/^[a-f0-9-]{36}$/.test(setup.credential?.bindingId)||setup.credential.adapter!=='claude'||!/^argo-remote-[a-f0-9]{12}$/.test(setup.skill))throw new Error('Invalid installation manifest');
const data=join(homedir(),'.argo');
const skillDir=join(homedir(),'.claude','skills',setup.skill);
if(existsSync(skillDir))throw new Error('Remote skill already exists; refusing to overwrite it');
const release=join(homedir(),'.local','share','argo','releases',randomUUID());
mkdirSync(join(data,'credentials'),{recursive:true,mode:0o700});
const credential=join(data,'credentials',setup.credential.bindingId+'.json');
if(existsSync(credential))throw new Error('Remote credential already exists');
execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--workspaces=false','--no-audit','--no-fund'],{cwd:stage,stdio:['ignore','inherit','inherit']});
mkdirSync(resolve(release,'..'),{recursive:true,mode:0o700});
renameSync(stage,release);chmodSync(release,0o700);
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const command=quote(process.execPath)+' '+quote(join(release,'bin','argo.mjs'));
let skill=readFileSync(join(release,'skills','argo-bind','SKILL.md'),'utf8');
skill=skill.replace('name: argo-bind','name: '+setup.skill);
skill=skill.replace(/\bargo (?=attach|next|ack|reply|leave)/g,command+' ');
skill=skill.replace(/ attach --name backend/g,' attach --credential '+quote(credential)+' --name '+quote(setup.name));
skill=skill.replace('Use the installed `argo` command, or the absolute `node /path/to/argo/bin/argo.mjs` launcher supplied with this skill.','Use the absolute launcher and scoped credential paths already embedded below. Do not read credential files or change PATH.');
writeFileSync(credential,JSON.stringify(setup.credential)+'\n',{flag:'wx',mode:0o600});
// The installation archive is transient, not a credential backup.
const {unlinkSync}=await import('node:fs');unlinkSync(join(release,'remote-setup.json'));
mkdirSync(skillDir,{recursive:true,mode:0o700});
writeFileSync(join(skillDir,'SKILL.md'),skill,{flag:'wx',mode:0o600});
console.log('ARGO_REMOTE_READY '+JSON.stringify({skill:setup.skill,launcher:join(release,'bin','argo.mjs')}));
