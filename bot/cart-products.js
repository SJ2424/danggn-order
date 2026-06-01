// 카트사이트(GAS) 취급 상품 목록 — 어느 봇이 처리할지 가르는 핵심 기준값.
//   · 카트봇(register-cart) / 카트송장봇(fetch-cart-tracking): 이 목록만 처리
//   · OMS봇(register-orders / fetch-tracking): 이 목록은 제외 (dooldool6611엔 없음 → 찾아도 매칭 실패)
// ⚠️ 예전엔 봇 파일마다 복붙이라 목록이 어긋날 위험이 있었음 → 여기 한 곳에서만 관리한다.
//   (프론트 index.html은 이 분류가 필요 없음 — 옛 미사용 사본은 제거됨)
// 철제선반은 선반랙(OMS) 취급 — 카트사이트 대상 아님 (cc39e7b에서 카트 목록서 제거됨)
export const CART_PRODUCTS = ['핸드카트', '하체마사지기', '족욕기', '날개없는 선풍기'];

export function isCartProduct(p) {
  if (!p) return false;
  const norm = p.replace(/\s+/g, '');
  return CART_PRODUCTS.some(cp => cp.replace(/\s+/g, '') === norm);
}
