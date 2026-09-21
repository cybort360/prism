export class ActivityService {
  constructor({ store, identityService }) { this.store=store; this.identityService=identityService; }
  list(prismId) {
    const data=this.store.read(); const items=[];
    for (const op of Object.values(data.operations)) {
      const i=op.intent??{};
      if (i.kind==='payment' && (i.senderPrismId===prismId || i.recipientPrismId===prismId)) {
        const incoming=i.recipientPrismId===prismId;
        const other=this.identityService.get(incoming?i.senderPrismId:i.recipientPrismId);
        items.push({id:op.operationId,kind:incoming?'received':'sent',direction:incoming?'incoming':'outgoing',counterpartyPrismId:other?.prismId??null,counterpartyHandle:other?.handle?`@${other.handle}`:null,amountAtomic:i.amountAtomic,token:i.token??null,tokenSymbol:i.tokenSymbol??null,memo:i.memo??'',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??op.receipt?.receipt?.transactionHash??null,requestId:i.requestId??null,claimId:null});
      }
      // A cross-chain send has no Prism recipient — the counterparty is an address on another
      // chain — so it needs its own branch or it would vanish from the feed entirely.
      if (i.kind==='aurora-send' && i.senderPrismId===prismId) {
        const route=(data.auroraRoutes??{})[i.routeId];
        items.push({id:op.operationId,kind:'cross-chain-sent',direction:'outgoing',counterpartyPrismId:null,counterpartyHandle:null,amountAtomic:i.amountAtomic,token:i.token??null,tokenSymbol:i.tokenSymbol??null,memo:route?`To ${route.destination.symbol} on ${route.destination.chainLabel}`:'Sent to another network',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??null,requestId:null,claimId:null,routeId:i.routeId??null,
        // The route's own state, kept distinct from the payment's: `status` above is the Monad leg,
        // and a completed Monad leg is not delivery.
        routeState:route?.state??null,destinationChain:route?.destination?.chainLabel??null,destinationSymbol:route?.destination?.symbol??null});
      }
      // Money into a Circle is an ordinary Prism payment that happens to pay a Safe, so it belongs
      // in the payer's own Activity like any other payment they made — labelled with the Circle,
      // and opening the same canonical receipt.
      if (i.kind==='circle-contribution' && i.senderPrismId===prismId) {
        const circle=i.circle??null;
        items.push({id:op.operationId,kind:'circle-contribution',direction:'outgoing',counterpartyPrismId:null,counterpartyHandle:null,amountAtomic:i.amountAtomic,token:i.token??null,tokenSymbol:i.tokenSymbol??null,memo:i.memo??'',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??op.txHash??null,requestId:null,claimId:null,
        sourceType:'circle',circleId:circle?.circleId??i.circleId??null,circleName:circle?.circleName??null,circleIcon:circle?.circleIcon??null});
      }
      if ((i.kind==='claim-funding'||i.kind==='claim-refund') && i.senderPrismId===prismId) {
        const claim=data.claims[i.claimId];
        items.push({id:op.operationId,kind:i.kind,direction:'outgoing',counterpartyPrismId:null,counterpartyHandle:null,claimId:i.claimId,amountAtomic:i.amountAtomic??claim?.amountAtomic??null,token:i.token??claim?.token??null,tokenSymbol:i.tokenSymbol??claim?.tokenSymbol??null,memo:i.kind==='claim-refund'?'Claim refund':'Waiting to be claimed',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??null,requestId:null});
      }
      if (i.kind==='claim-collection' && i.recipientPrismId===prismId) {
        const claim=data.claims[i.claimId]; const sender=this.identityService.get(claim?.senderPrismId);
        items.push({id:op.operationId,kind:'claim-received',direction:'incoming',counterpartyPrismId:sender?.prismId??null,counterpartyHandle:sender?.handle?`@${sender.handle}`:null,claimId:i.claimId,amountAtomic:claim?.amountAtomic??null,token:claim?.token??null,tokenSymbol:claim?.tokenSymbol??null,memo:'Claimed payment',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??null,requestId:null});
      }
    }
    // Device-P256 smart-account payments live in their own bucket (p256Ops), and pay a raw address
    // (no Prism recipient), so they need their own branch or they never appear in the feed.
    for (const op of Object.values(data.p256Ops??{})) {
      if (op.prismId!==prismId) continue;
      const i=op.intent??{};
      const addr=i.recipient?`${i.recipient.slice(0,6)}…${i.recipient.slice(-4)}`:null;
      items.push({id:op.operationId,kind:'p256-sent',direction:'outgoing',counterpartyPrismId:null,counterpartyHandle:addr,amountAtomic:i.amount??null,token:i.token??null,tokenSymbol:'USDC',memo:'Device-key payment',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.txHash??null,requestId:null,claimId:null});
    }
    // Save deposits and withdrawals are real money movements, so they appear in Activity — but yield
    // accrual is position appreciation, NOT a Prism payment, so it NEVER creates daily transaction rows.
    // Only actual SAVE / WITHDRAW operations are projected here.
    const saveAccount = this.identityService?.get?.(prismId)?.accountAddress;
    if (saveAccount) {
      const savePositionId = `save_${saveAccount.toLowerCase()}`;
      for (const op of Object.values(data.saveOperations??{})) {
        if (op.positionId!==savePositionId) continue;
        if (op.kind==='SAVE') {
          items.push({id:op.operationId,kind:'save-deposit',direction:'outgoing',counterpartyPrismId:null,counterpartyHandle:'Savings',amountAtomic:op.inputUSDC??null,token:null,tokenSymbol:'USDC',memo:'Saved',status:op.state==='SAVED'?'COMPLETED':(op.state==='FAILED'?'FAILED':'PENDING'),createdAt:op.createdAt,transactionHash:op.transactionHash??null,requestId:null,claimId:null,sourceType:'save'});
        } else if (op.kind==='WITHDRAW_INSTANT'||op.kind==='WITHDRAW_STANDARD'||op.kind==='CLAIM_WITHDRAWAL') {
          const done=op.state==='AVAILABLE';
          items.push({id:op.operationId,kind:'save-withdraw',direction:'incoming',counterpartyPrismId:null,counterpartyHandle:'Savings',amountAtomic:op.outputUSDC??null,token:null,tokenSymbol:'USDC',memo:done?'Savings withdrawal':'Withdrawal',status:done?'COMPLETED':'PENDING',createdAt:op.submittedAt??op.createdAt,transactionHash:op.transactionHash??null,requestId:null,claimId:null,sourceType:'save'});
        }
      }
    }
    // Money OUT of a Circle lands in a person's account exactly as any other payment does, so it has
    // to appear in the recipient's Activity — the payer is the Circle, not the admin who proposed it.
    // These rows are projections of the same reconciled records the Circle's own feed reads; there is
    // no second history anywhere.
    for (const proposal of Object.values(data.circleProposals??{})) {
      if (proposal.kind!=='PAYMENT' || proposal.recipientPrismId!==prismId) continue;
      if (!['SUBMITTED','CONFIRMING','CONFIRMED','RECONCILED','COMPLETED'].includes(proposal.lifecycle)) continue;
      const circle=data.circles?.[proposal.circleId];
      items.push({id:proposal.proposalId,kind:'circle-received',direction:'incoming',counterpartyPrismId:null,counterpartyHandle:circle?.name??null,amountAtomic:proposal.amount,token:proposal.token??null,tokenSymbol:proposal.asset??'USDC',memo:proposal.memo??'',status:circleConsumerState(proposal.lifecycle),createdAt:proposal.executedAt??proposal.createdAt,transactionHash:proposal.executionTxHash??null,requestId:null,claimId:null,
      sourceType:'circle',circleId:proposal.circleId,circleName:circle?.name??null,circleIcon:circle?.icon??null});
    }
    for (const spend of Object.values(data.circleSpends??{})) {
      if (spend.recipientPrismId!==prismId) continue;
      if (!['SUBMITTED','CONFIRMING','COMPLETED'].includes(spend.status)) continue;
      const circle=data.circles?.[spend.circleId];
      items.push({id:spend.spendId,kind:'circle-received',direction:'incoming',counterpartyPrismId:null,counterpartyHandle:circle?.name??null,amountAtomic:spend.amount,token:spend.token??null,tokenSymbol:spend.asset??'USDC',memo:spend.memo??'',status:spend.status==='COMPLETED'?'COMPLETED':'PENDING',createdAt:spend.completedAt??spend.createdAt,transactionHash:spend.transactionHash??null,requestId:null,claimId:null,
      sourceType:'circle',circleId:spend.circleId,circleName:circle?.name??null,circleIcon:circle?.icon??null});
    }
    for(const r of Object.values(data.requests)) if(r.status!=='DRAFT'&&(r.requesterPrismId===prismId||r.payerPrismId===prismId)) {
      const outgoing=r.requesterPrismId===prismId; const other=this.identityService.get(outgoing?r.payerPrismId:r.requesterPrismId);
      items.push({id:r.requestId,kind:'request',direction:outgoing?'outgoing':'incoming',counterpartyPrismId:other?.prismId??null,counterpartyHandle:other?.handle?`@${other.handle}`:null,amountAtomic:r.amountAtomic,token:r.token,tokenSymbol:r.tokenSymbol??null,memo:r.memo,status:r.status,createdAt:r.createdAt,transactionHash:r.transactionHash??null,requestId:r.requestId,claimId:null,requesterPrismId:r.requesterPrismId,payerPrismId:r.payerPrismId});
    }
    return items.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  }
}
// The Circle payment lifecycle in the same consumer vocabulary the rest of Activity uses. COMPLETED
// is the only settled value, exactly as it is for a personal payment.
function circleConsumerState(lifecycle){if(lifecycle==='COMPLETED')return 'COMPLETED';if(lifecycle==='FAILED'||lifecycle==='INVALIDATED')return 'FAILED';return 'PENDING';}
function consumerState(state){if(state==='completed')return 'COMPLETED';if(state==='failed')return 'FAILED';if(state==='confirming'||state==='submitted')return 'PENDING';return String(state??'').toUpperCase();}
