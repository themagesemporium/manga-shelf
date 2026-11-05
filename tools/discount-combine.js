// Keeps the "Free Lucky Pack with $60+" automatic discount from being knocked out by a coupon.
// Shopify only stacks two discounts when BOTH allow the other's class, so every active/scheduled code (Privy makes new ones
// all the time with combining off) gets combinesWith.productDiscounts = true, and the Lucky Pack combines with everything.
// Side effect: a product-class code and an order-class code can now stack on one order; two product discounts on the
// same item never stack (Shopify applies the better one per item).
// Run in a Shopify admin tab with window._api defined: _dcRun({days: 2}) (only codes created in the last N days; omit for all).
// Result in window._DC {codes, upd, auto, err, fin}.
window._dcRun = async (opt = {}) => {
  const L = window._DC = { codes: 0, upd: 0, auto: [], err: [], fin: false };
  const F = 'title status discountClass combinesWith{orderDiscounts productDiscounts shippingDiscounts}';
  const MA = { DiscountAutomaticBxgy: ['discountAutomaticBxgyUpdate', 'automaticBxgyDiscount', 'DiscountAutomaticBxgyInput'], DiscountAutomaticBasic: ['discountAutomaticBasicUpdate', 'automaticBasicDiscount', 'DiscountAutomaticBasicInput'], DiscountAutomaticFreeShipping: ['discountAutomaticFreeShippingUpdate', 'freeShippingAutomaticDiscount', 'DiscountAutomaticFreeShippingInput'] };
  const MC = { DiscountCodeBasic: ['discountCodeBasicUpdate', 'basicCodeDiscount', 'DiscountCodeBasicInput'], DiscountCodeFreeShipping: ['discountCodeFreeShippingUpdate', 'freeShippingCodeDiscount', 'DiscountCodeFreeShippingInput'], DiscountCodeBxgy: ['discountCodeBxgyUpdate', 'bxgyCodeDiscount', 'DiscountCodeBxgyInput'] };
  const upd = async (M, id, cw) => { const u = await _api(`mutation($id:ID!,$d:${M[2]}!){${M[0]}(id:$id,${M[1]}:$d){userErrors{message}}}`, { id, d: { combinesWith: cw } }); return u.data ? u.data[M[0]].userErrors : u.errors; };
  try {
    const a = await _api(`{automaticDiscountNodes(first:50,query:"status:active OR status:scheduled"){nodes{id automaticDiscount{__typename ... on DiscountAutomaticBxgy{${F}} ... on DiscountAutomaticBasic{${F}} ... on DiscountAutomaticFreeShipping{${F}}}}}}`);
    for (const n of a.data.automaticDiscountNodes.nodes){ const d = n.automaticDiscount; if (!MA[d.__typename]) continue;
      const cw = Object.assign({}, d.combinesWith, /lucky pack/i.test(d.title) ? { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true } : { productDiscounts: true });
      if (JSON.stringify(cw) === JSON.stringify(d.combinesWith)) continue; const ue = await upd(MA[d.__typename], n.id, cw); L.auto.push(d.title + (ue && ue.length ? ' ' + JSON.stringify(ue).slice(0, 100) : ' fixed')); }
    const q = 'status:active OR status:scheduled' + (opt.days ? ' AND created_at:>' + new Date(Date.now() - opt.days * 864e5).toISOString().slice(0, 10) : '');
    let after = null;
    do { const r = await _api(`query($a:String,$q:String){codeDiscountNodes(first:100,after:$a,query:$q){pageInfo{hasNextPage endCursor} nodes{id codeDiscount{__typename ... on DiscountCodeBasic{${F}} ... on DiscountCodeFreeShipping{${F}} ... on DiscountCodeBxgy{${F}}}}}}`, { a: after, q });
      for (const n of r.data.codeDiscountNodes.nodes){ L.codes++; const d = n.codeDiscount; if (!MC[d.__typename] || !d.combinesWith || d.combinesWith.productDiscounts) continue;
        const ue = await upd(MC[d.__typename], n.id, Object.assign({}, d.combinesWith, { productDiscounts: true })); if (ue && ue.length) L.err.push(d.title + ' ' + JSON.stringify(ue).slice(0, 120)); else L.upd++; }
      after = r.data.codeDiscountNodes.pageInfo.hasNextPage ? r.data.codeDiscountNodes.pageInfo.endCursor : null; } while (after);
  } catch (e) { L.err.push(String(e).slice(0, 150)); }
  L.fin = true;
};
