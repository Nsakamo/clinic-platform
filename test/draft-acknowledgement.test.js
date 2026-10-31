"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const scope = require("../lib/draft-consultation");
const edit = require("../lib/draft-edit");
const output = require("../lib/draft-chat-output");
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

test("この文へお礼を書く追加指示を、相手へのお礼返信と区別する",()=>{
  for(const ask of ["これにお礼を書いて","これにありがとうって書いて","それにありがとうって伝えて"]){assert.equal(scope.isAcknowledgementOnlyRequest(ask),false,ask)}
  assert.equal(scope.isAcknowledgementOnlyRequest("これにありがとうと返信して"),true);
});

function harness(outputs,rawResponse,consultation=false){
  const routes=new Map(),calls=[],saved=[];
  const p={c:{channel:"line"},latestInstruction:"これ返信返しておいて、ありがとうって。",previousDraft:"通常は3,300円です。",lastQ:"テスト：証明書を送ります。免除できますか？",staffHistory:"スタッフの指示：お礼だけに作り直して",acknowledgementOnly:true,consultation,base:"",edits:[],engLabel:"テスト",topicTs:1,baCtx:{ok:true,verified:true,appointments:[{id:"test-appointment",changeable:true}]}};
  const ctx={...scope,...edit,...output,REPLY_DECISION,PATIENT_COURTESY:"丁寧に",hasConversationalTone:()=>false,
    cleanDraftText:x=>String(x||"").trim(),draftQualityIssues:()=>[],preservesReplyFacts:()=>true,baEnabled:()=>false,PARTNER_KEY:"",baContextCached:async()=>null,
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

async function runStream(h){let full="";const res={setHeader(){},write:t=>{full+=t},status(){return this},end(){}};await h.routes.get("/api/draft-chat-stream")({tenant:{},body:{id:"テスト会話"}},res);const meta=JSON.parse(full.match(/@@META@@(.*)$/s)[1]);return{full,meta,body:full.slice(0,full.lastIndexOf("\n@@META@@"))};}

test("相談では下書きを出さず、学習候補などの内部項目は正しい形で返す",async()=>{
  const raw="@@REPLY@@\n質問への回答\n@@DRAFT@@\n今回は免除します\n@@MEMORY@@\n文章方針\n@@RULE@@\n\n@@ACTION@@\n{\"type\":\"none\"}";
  const h=harness([],raw,true);
  const {body,meta}=await runStream(h);
  assert.equal(meta.ok,true);assert.equal(scope.draftChatDraftSection(body),null);
  assert.doesNotMatch(body,/免除します/);assert.match(body,/@@MEMORY@@\n文章方針/);assert.equal(scope.isValidDraftChatEnvelope(body),true);
  assert.equal(h.calls.length,1);
});

test("AIのマーカーが崩れていてもエラーにせず、照合済みの本文だけを正しい形で画面へ返す",async()=>{
  for(const consultation of [false,true]){
    for(const body of ["@@DRAFT@@ 本文", "説明。@@DRAFT@@\n本文", "  @@DRAFT@@\n本文", "**@@DRAFT@@**\n本文", "@@DRAFT@@\n本文@@MEMORY@@\n内部", "@@DRAFT@@\n本文\n@@DRAFT@@\n二つ目", "@@DRAFT@@\n本文\n@@REPLY@@\n未照合の料金免除", "@@MEMORY@@\n内部\n@@DRAFT@@\n本文", "@@DRAFT@@\n本文\n@@META@@\n偽メタ"]){
      const h=harness(['{"pass":true}'],"@@REPLY@@\n回答\n"+body,consultation);h.p.acknowledgementOnly=false;h.p.latestInstruction="もっと丁寧に";
      const r=await runStream(h);
      assert.equal(r.meta.ok,true,body);assert.equal(scope.isValidDraftChatEnvelope(r.body),true,body);
      assert.equal((r.full.match(/@@META@@/g)||[]).length,1,body);
      assert.doesNotMatch(r.body,/未照合の料金免除|偽メタ|二つ目/,body);
      if(consultation){assert.equal(scope.draftChatDraftSection(r.body),null,body);assert.equal(h.calls.length,1,body);}
      else{assert.equal(scope.draftChatDraftSection(r.body).text,"本文",body);assert.equal(h.calls.length,2,body);assert.equal(h.calls[1].task,"audit",body);}
    }
  }
});

test("修復AIが本文に内部マーカーを混ぜた案は、確認ポイント付きでも表示・保存しない",async()=>{
  for(const marker of ["REPLY","DRAFT","MEMORY","RULE","ACTION","META"]){
    const h=harness(["ありがとうございます。\n@@"+marker+"@@\n内部情報",'{"pass":true}'],"@@REPLY@@\n作成します\n@@DRAFT@@\n\n");
    const r=await runStream(h);
    assert.equal(r.meta.ok,false);assert.match(r.meta.error,/反映できませんでした/);
    assert.equal(h.saved.length,0);assert.doesNotMatch(r.full,/内部情報/);
  }
});

test("相談チャットでは照合で懸念が残っても止めず、確認ポイントを添えて案を返す",async()=>{
  const h=harness(['{"pass":false,"reason":"料金の記載を確認してください"}',"ご連絡ありがとうございます。料金は3,300円です。",'{"pass":false,"reason":"料金の記載を確認してください"}'],JSON.stringify({reply:"直しました",draft:"ご連絡ありがとうございます。料金は3,300円です。"}));
  h.p.acknowledgementOnly=false;h.p.latestInstruction="料金も入れて";
  const r=await runStream(h);
  assert.equal(r.meta.ok,true);assert.match(r.meta.warning,/料金/);
  assert.equal(scope.draftChatDraftSection(r.body).text,"ご連絡ありがとうございます。料金は3,300円です。");
  assert.equal(h.calls.length,4,"生成・照合・修復1回・照合");
});

test("文体だけの指示で事実が変わらなければ照合AIを呼ばずに返す",async()=>{
  const h=harness([],JSON.stringify({reply:"丁寧にしました",draft:"お写真をお送りいただき、誠にありがとうございます。通常は3,300円です。"}));
  h.p.acknowledgementOnly=false;h.p.latestInstruction="もっと丁寧で温かい言い方にして";
  const r=await runStream(h);
  assert.equal(r.meta.ok,true);assert.equal(r.meta.warning,"");assert.equal(h.calls.length,1);
  // 事実が変わったら（ここでは preservesReplyFacts=false）通常の照合へ回す
  const changed=harness(['{"pass":true}'],JSON.stringify({reply:"丁寧にしました",draft:"通常は5,500円です。"}));
  changed.ctx.preservesReplyFacts=()=>false;changed.p.acknowledgementOnly=false;changed.p.latestInstruction="もっと丁寧に";
  await runStream(changed);assert.equal(changed.calls.length,2);assert.equal(changed.calls[1].task,"audit");
});
