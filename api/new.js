// GET /api/new?sido=230000&months=3&types=31,21
// 인증키(HIRA_KEY)는 Vercel 환경변수에만 두고 브라우저에는 보내지 않는다.
import { findNewClinics, SIDO, TYPES, DEFAULT_TYPES } from "../lib/hira.js";

export default async function handler(req, res) {
  const q = req.query || {};
  const sido = String(q.sido || "230000");
  const months = Math.min(Math.max(parseInt(q.months, 10) || 3, 1), 24);
  const types = String(q.types || DEFAULT_TYPES.join(","))
    .split(",").map((s) => s.trim()).filter((t) => TYPES[t]);

  if (!SIDO[sido]) return res.status(400).json({ error: "알 수 없는 지역 코드예요." });
  if (!types.length) return res.status(400).json({ error: "기관 종류를 하나 이상 골라 주세요." });

  const key = process.env.HIRA_KEY;
  if (!key) {
    return res.status(500).json({
      error: "NO_KEY",
      message: "서버에 공공데이터 인증키(HIRA_KEY)가 아직 설정되지 않았어요.",
    });
  }

  try {
    const r = await findNewClinics({ key, sido, months, types });
    // 같은 조건은 6시간 동안 Vercel 캐시에서 바로 응답 (심평원 호출량 절약)
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json({
      sido, sidoName: SIDO[sido], months, types,
      since: r.since, scanned: r.scanned, count: r.items.length,
      source: "건강보험심사평가원 병원정보서비스 (개설일자 기준)",
      at: new Date().toISOString(),
      items: r.items,
    });
  } catch (e) {
    return res.status(502).json({ error: "UPSTREAM", message: e.message || "심평원 서버 응답을 받지 못했어요." });
  }
}
