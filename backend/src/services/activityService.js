export class ActivityService {
  constructor({ store, identityService }) { this.store=store; this.identityService=identityService; }
  list(prismId) {
    const data=this.store.read(); const items=[];
    for (const op of Object.values(data.operations)) {
      const i=op.intent??{};
      if (i.kind==='payment' && (i.senderPrismId===prismId || i.recipientPrismId===prismId)) {
        const incoming=i.recipientPrismId===prismId;
        const other=this.identityService.get(incoming?i.senderPrismId:i.recipientPrismId);
        items.push({id:op.operationId,kind:incoming?'received':'sent',direction:incoming?'incoming':'outgoing',counterpartyPrismId:other?.prismId??null,counterpartyHandle:other?.handle?`@${other.handle}`:null,amountAtomic:i.amountAtomic,memo:i.memo??'',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??op.receipt?.receipt?.transactionHash??null,requestId:i.requestId??null,claimId:null});
      }
      if ((i.kind==='claim-funding'||i.kind==='claim-refund') && i.senderPrismId===prismId) {
        const claim=data.claims[i.claimId];
        items.push({id:op.operationId,kind:i.kind,direction:'outgoing',counterpartyPrismId:null,counterpartyHandle:null,claimId:i.claimId,amountAtomic:i.amountAtomic??claim?.amountAtomic??null,memo:i.kind==='claim-refund'?'Claim refund':'Waiting to be claimed',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??null,requestId:null});
      }
      if (i.kind==='claim-collection' && i.senderPrismId===prismId) {
        const claim=data.claims[i.claimId]; const sender=this.identityService.get(claim?.senderPrismId);
        items.push({id:op.operationId,kind:'claim-received',direction:'incoming',counterpartyPrismId:sender?.prismId??null,counterpartyHandle:sender?.handle?`@${sender.handle}`:null,claimId:i.claimId,amountAtomic:claim?.amountAtomic??null,memo:'Claimed payment',status:consumerState(op.state),createdAt:op.createdAt,transactionHash:op.transactionHash??null,requestId:null});
      }
    }
    for(const r of Object.values(data.requests)) if(r.status!=='DRAFT'&&(r.requesterPrismId===prismId||r.payerPrismId===prismId)) {
      const outgoing=r.requesterPrismId===prismId; const other=this.identityService.get(outgoing?r.payerPrismId:r.requesterPrismId);
      items.push({id:r.requestId,kind:'request',direction:outgoing?'outgoing':'incoming',counterpartyPrismId:other?.prismId??null,counterpartyHandle:other?.handle?`@${other.handle}`:null,amountAtomic:r.amountAtomic,memo:r.memo,status:r.status,createdAt:r.createdAt,transactionHash:r.transactionHash??null,requestId:r.requestId,claimId:null,requesterPrismId:r.requesterPrismId,payerPrismId:r.payerPrismId});
    }
    return items.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  }
}
function consumerState(state){if(state==='completed')return 'COMPLETED';if(state==='failed')return 'FAILED';if(state==='confirming'||state==='submitted')return 'PENDING';return String(state??'').toUpperCase();}
