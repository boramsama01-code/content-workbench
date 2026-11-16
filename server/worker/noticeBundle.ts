import {randomUUID} from 'node:crypto';
import type {DB} from '../db';
import {env} from '../env';
import {NOTICE_BUNDLE_JOB,processNoticeBundleJob,stopActiveNoticeBundles} from '../services/noticeBundle';
import {claimJob,recoverExpired} from './queue';

let running:Promise<void>|null=null,timer:ReturnType<typeof setInterval>|null=null,stopping=false;
export function kickNoticeBundles(db:DB){
 if(stopping||!env.inlineWorker||env.canonicalRedirectUrl||running)return;
 running=(async()=>{
  await recoverExpired(db);
  const workerId=`web-notice-bundle-${randomUUID()}`;
  for(let step=0;step<12&&!stopping;step++){
   const job=await claimJob(db,workerId,[NOTICE_BUNDLE_JOB]);if(!job)break;
   await processNoticeBundleJob(db,job,workerId);
  }
 })().catch(()=>console.error('[모집 공고 묶기] 저장된 작업을 다음 실행에서 확인합니다.')).finally(()=>{running=null;});
}
export function startNoticeBundles(db:DB){
 if(stopping||timer||!env.inlineWorker||env.canonicalRedirectUrl)return;
 kickNoticeBundles(db);timer=setInterval(()=>kickNoticeBundles(db),5000);timer.unref();
}
export async function stopNoticeBundles(){stopping=true;stopActiveNoticeBundles();if(timer)clearInterval(timer);timer=null;await running;}
