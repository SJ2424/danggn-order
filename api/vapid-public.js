// VAPID Public Key 노출 — 클라이언트가 구독 만들 때 사용
// Public key는 공개돼도 보안 문제 X (Private만 비밀)
// 코드 하드코딩 대신 Vercel 환경변수에서 받음 → 키 회전시 코드 변경 불필요

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');  // 5분 캐싱
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'VAPID_PUBLIC_KEY 환경변수가 Vercel에 등록 안 됨',
      hint: 'Vercel Settings → Environment Variables에 VAPID_PUBLIC_KEY 추가 필요'
    });
  }
  return res.status(200).json({ key });
}
