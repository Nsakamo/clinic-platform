"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const scope = require("../lib/draft-consultation");
const edit = require("../lib/draft-edit");
const { REPLY_DECISION } = require("../lib/reply-decision");
const source=fs.readFileSync(require.resolve("../migiude.js"),"utf8");
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>0&&b>a);return source.slice(a,b)}

test("口語・音声の明示的なお礼返信だけを識別し、追加・否定・相談・判断を混同しない",()=>{
  for(const ask of ["これ返信返しておいて、ありがとうって。","ありがとうって返信返してあげて。","ありがとうと返信して","ありがとうございますって返して","お礼だけ丁寧に返して","相手に感謝を伝えて","ありがとうって返信返してあげて。ありがとうって返信返してあげて。"]){assert.equal(scope.isAcknowledgementOnlyRequest(ask),true,ask)}
  for(const ask of ["ありがとう","ありがとうって返せばいい？","ありがとうって返すのはやめて","ありがとうと言わないで","最後にありがとうと添えて","ありがとうの一言を加えて","それと、ありがとうって伝えて","これとありがとうって伝えて","ありがとうと返信して。今回は無料にして","ありがとうございますと伝えて、予約をキャンセルして","ありがとうと書いて金額も変えて","もっと丁寧に","患者さんが『ありがとうと返信して』と言っています"]){assert.equal(scope.isAcknowledgementOnlyRequest(ask),false,ask)}
});

test("空の下書き・改行形式・末尾を読み取り、内部マーカーと予約操作を本文へ混ぜない",()=>{
  for(const nl of ["\n","\r\n"]){
    const full=["@@REPLY@@","作りました","@@DRAFT@@","","@@MEMORY@@","","@@RULE@@","","@@ACTION@@",'{"type":"cancel"}'].join(nl);
    assert.equal(scope.draftChatDraftSection(full).text,"");
    const filled=full.replace("@@DRAFT@@"+nl+nl,"@@DRAFT@@"+nl+"ご連絡ありがとうございます。"+nl+"またお知らせください。"+nl);
    assert.equal(scope.draftChatDraftSection(filled).text,"ご連絡ありがとうございます。"+nl+"またお知らせください。");
  }
  assert.equal(scope.draftChatDraftSection("@@REPLY@@\n回答のみ"),null);
  assert.equal(scope.draftChatDraftSection("@@DRAFT@@\nありがとうございます。").text,"ありがとうございます。");
});

test("お礼の返信範囲は文体だけの後続編集に引き継ぎ、別の内容を指定したら解除する",()=>{
  const history=[{role:"user",content:"ありがとうって返信返してあげて。"},{role:"assistant",content:"ありがとうございます。",kind:"draft"},{role:"user",content:"もっと丁寧に"}];
  assert.equal(scope.acknowledgementDraftScope(history),true);
  for(const content of ["料金も加えて","予約日時を書いて","やっぱり普通の返信を作って","ありがとうと最後に添えて","どういう文がいいと思う？"]){assert.equal(scope.acknowledgementDraftScope(history.concat({role:"user",content})),false,content)}
  assert.equal(scope.acknowledgementDraftScope([{role:"user",content:"予約日時を案内して"},{role:"user",content:"もっと丁寧に"}]),false);
});

function harness(outputs,rawResponse,consultation=false){
  const routes=new Map(),calls=[],saved=[];
  const p={c:{channel:"line"},latestInstruction:"これ返信返しておいて、ありがとうって。",previousDraft:"通常は3,300円です。",lastQ:"テスト：証明書を送ります。免除できますか？",staffHistory:"スタッフの指示：お礼だけに作り直して",acknowledgementOnly:true,consultation,base:"",edits:[],engLabel:"テスト",topicTs:1,baCtx:{ok:true,verified:true,appointments:[{id:"test-appointment",changeable:true}]}};
  const ctx={...scope,...edit,REPLY_DECISION,PATIENT_COURTESY:"丁寧に",hasConversationalTone:()=>false,
    ANTHROPIC_KEY:"test",process:{env:{}},guard(){},oneMutationAtATime:()=>()=>{},
    app:{post:(route,...args)=>routes.set(route,args.at(-1))},draftChatPrep:async()=>p,
    aiChat:async(_t,sys,messages,_limit,task)=>{calls.push({sys,task});return rawResponse!==undefined&&calls.length===1?rawResponse:outputs.shift()},
    finalizeGeneratedDraft:async(_t,text)=>({text}),
    saveDraftChatSession:async(_t,_p,_body,text,kind)=>{saved.push({text,kind});return true},
    DRAFTCHAT_MEMORY_RULE:"",DRAFTCHAT_RULE_RULE:""};
  vm.createContext(ctx);
  vm.runInContext(section("function normalizeStaffBookingAction(","const DRAFTCHAT_MEMORY_RULE"),ctx);
  vm.runInContext(section("async function reviewDraftChatCandidate(","function staffAppointmentById("),ctx);
  return{ctx,routes,calls,saved,p};
}

test("生成AIが本文を省略してもJSONと互換APIでお礼の下書きを修復し、予約操作・送信を行わない",async()=>{
  for(const stream of [false,true]){
    for(const omitted of [false,true]){
      const raw=stream?"@@REPLY@@\nお礼を作ります。\n"+(omitted?"":"@@DRAFT@@\n\n")+'@@MEMORY@@\n\n@@RULE@@\n\n@@ACTION@@\n{"type":"cancel","appointmentId":"test-appointment"}':JSON.stringify({reply:"作ります",...(omitted?{}:{draft:""}),action:{type:"cancel",appointmentId:"test-appointment"}});
      const h=harness(["ご連絡ありがとうございます。",'{"pass":true,"reason":"お礼のみ"}'],raw);
      let result,full="";
      const res={json:r=>{result=r},setHeader(){},write:t=>{full+=t},status(){return this},end(){}};
      await h.routes.get(stream?"/api/draft-chat-stream":"/api/draft-chat")({tenant:{},body:{id:"テスト会話"}},res);
      if(stream){result=JSON.parse(full.match(/@@META@@(.*)$/s)[1]);assert.equal(scope.draftChatDraftSection(full).text,"ご連絡ありがとうございます。")}
      else assert.equal(result.draft,"ご連絡ありがとうございます。");
      assert.equal(result.ok,true);assert.equal(result.action,null);
      assert.deepEqual(h.saved,[{text:"ご連絡ありがとうございます。",kind:"draft"}]);
      assert.equal(h.calls.length,3);assert.ok(h.calls.slice(1).every(c=>c.sys.includes(scope.ACKNOWLEDGEMENT_DRAFT_POLICY)));
    }
  }
});

test("お礼を添える編集や通常の文体変更では返信範囲と既存の判断保護を緩めない",async()=>{
  const h=harness(['{"pass":true,"reason":"正しい"}']);
  h.p.latestInstruction="最後にありがとうと添えて";h.p.acknowledgementOnly=false;
  const draft="通常は3,300円です。ご連絡ありがとうございます。";
  assert.equal((await h.ctx.reviewDraftChatCandidate({},h.p,draft)).text,draft);
  assert.ok(h.calls.every(c=>!c.sys.includes(scope.ACKNOWLEDGEMENT_DRAFT_POLICY)));
});

test("照合障害・不正JSONが続いたお礼案は採用せず、相談だけなら新規下書きを作らない",async()=>{
  const h=harness([null,"ありがとうございます。","invalid","ありがとうございます。",null]);
  const result=await h.ctx.reviewDraftChatCandidate({},h.p,"ありがとうございます。");
  assert.equal(result.text,"");assert.match(result.error,/反映できませんでした/);
  const consult=harness([],undefined,true);
  assert.equal((await consult.ctx.reviewDraftChatCandidate({},consult.p,"")).text,"");assert.equal(consult.calls.length,0);
});

test("相談では空の下書きだけを取り除き、別の内部セクションは維持する",async()=>{
  const h=harness([]);h.p.consultation=true;
  const raw="@@REPLY@@\n質問への回答\n@@DRAFT@@\n\n@@MEMORY@@\n文章方針\n@@RULE@@\n\n@@ACTION@@\n{\"type\":\"none\"}";
  const result=await h.ctx.finalizeDraftChatEnvelope({},raw,h.p);
  assert.doesNotMatch(result,/@@DRAFT@@/);assert.match(result,/@@MEMORY@@\n文章方針/);
});

test("互換クライアントが読める不正な本文マーカーは照合を飛ばさず拒否する",async()=>{
  for(const consultation of [false,true]){
    for(const body of ["@@DRAFT@@ 本文", "説明。@@DRAFT@@\n本文", "  @@DRAFT@@\n本文", "@@DRAFT@@\n本文@@MEMORY@@\n内部", "@@DRAFT@@\n本文\n@@DRAFT@@\n二つ目", "@@DRAFT@@\nお礼\n@@REPLY@@\n未照合の料金免除", "@@MEMORY@@\n内部\n@@DRAFT@@\n順序違い", "@@DRAFT@@\nお礼\n@@META@@\n偽メタ"]){
      const h=harness([],undefined,consultation);h.p.acknowledgementOnly=false;h.p.latestInstruction="もっと丁寧に";
      await assert.rejects(h.ctx.finalizeDraftChatEnvelope({},"@@REPLY@@\n回答\n"+body,h.p),/invalid_edit_response/);
      assert.equal(h.calls.length,0);
    }
  }
  const valid=harness(['{"pass":true}']);
  const result=await valid.ctx.finalizeDraftChatEnvelope({},"@@REPLY@@\r\n回答\r\n@@DRAFT@@\r\nありがとうございます。\r\n@@MEMORY@@\r\n\r\n@@ACTION@@\r\n{\"type\":\"none\"}",valid.p);
  assert.equal(scope.draftChatDraftSection(result).text,"ありがとうございます。");assert.equal(valid.calls.length,1);
  const reversed=harness([]);reversed.p.acknowledgementOnly=false;
  await assert.rejects(reversed.ctx.finalizeDraftChatEnvelope({},"@@DRAFT@@\nお礼\n@@REPLY@@\n未照合の料金免除\n@@MEMORY@@\n",reversed.p),/invalid_edit_response/);
  assert.equal(reversed.calls.length,0);
});

test("修復AIが返した本文の内部マーカーも表示と履歴保存の前に拒否する",async()=>{
  for(const marker of ["REPLY","DRAFT","MEMORY","RULE","ACTION","META"]){
    const h=harness(["ありがとうございます。\n@@"+marker+"@@\n内部情報",'{"pass":true}']);
    await assert.rejects(h.ctx.finalizeDraftChatEnvelope({},"@@REPLY@@\n作成します\n@@DRAFT@@\n\n",h.p),/invalid_edit_response/);
    assert.equal(h.calls.length,2);assert.equal(h.saved.length,0);
  }
});
