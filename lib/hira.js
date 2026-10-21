// 건강보험심사평가원 병원정보서비스(공공데이터포털) 호출과 신규 개원 필터링
// 문서: https://www.data.go.kr/data/15001698/openapi.do

export const HIRA_URL =
  process.env.HIRA_URL ||
  "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList";

// 심평원 시·도 코드
export const SIDO = {
  "110000": "서울", "210000": "부산", "220000": "인천", "230000": "대구",
  "250000": "대전", "260000": "울산", "310000": "경기", "320000": "강원",
  "330000": "충북", "340000": "충남", "350000": "전북", "360000": "전남·광주",
  "370000": "경북", "380000": "경남", "390000": "제주", "410000": "세종",
};

// 심평원 종별 코드
export const TYPES = {
  "01": "상급종합", "11": "종합병원", "21": "병원", "28": "요양병원",
  "29": "정신병원", "31": "의원", "41": "치과병원", "51": "치과의원",
  "92": "한방병원", "93": "한의원",
};

export const DEFAULT_TYPES = ["31", "21", "11", "28"];
const PAGE_SIZE = 1000;
const CONCURRENCY = 5;

/** 오늘(한국 시간)에서 months개월 전 날짜를 YYYYMMDD로 */
export function cutoffDate(months, now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600e3);
  kst.setUTCMonth(kst.getUTCMonth() - months);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

/** 포털에서 받은 키가 인코딩 키(%포함)든 디코딩 키든 그대로 쓸 수 있게 */
function keyParam(key) {
  return key.includes("%") ? key : encodeURIComponent(key);
}

function xmlItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = f[2];
    items.push(o);
  }
  return items;
}

/** 응답(JSON 또는 XML)을 { items, total } 으로 */
export function parseResponse(text) {
  const t = text.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    const head = j.response?.header;
    if (head && head.resultCode !== "00") throw new Error(`심평원 오류 ${head.resultCode}: ${head.resultMsg}`);
    const body = j.response?.body || {};
    let items = body.items?.item ?? [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    return { items, total: Number(body.totalCount) || 0 };
  }
  const err = t.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/) || t.match(/<errMsg>([^<]*)<\/errMsg>/);
  const code = t.match(/<resultCode>([^<]*)<\/resultCode>/);
  if (err || (code && code[1] !== "00")) {
    const msg = t.match(/<resultMsg>([^<]*)<\/resultMsg>/);
    throw new Error(`심평원 오류: ${err ? err[1] : msg ? msg[1] : code[1]}`);
  }
  const total = t.match(/<totalCount>(\d+)<\/totalCount>/);
  return { items: xmlItems(t), total: total ? Number(total[1]) : 0 };
}

async function fetchPage({ key, sido, clCd, pageNo, fetchImpl }) {
  const url =
    `${HIRA_URL}?ServiceKey=${keyParam(key)}&_type=json&numOfRows=${PAGE_SIZE}` +
    `&pageNo=${pageNo}&sidoCd=${sido}&clCd=${clCd}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (!r.ok && !text.trim().startsWith("<") && !text.trim().startsWith("{")) throw new Error(`HTTP ${r.status}`);
      return parseResponse(text);
    } catch (e) {
      lastErr = e;
      if (/SERVICE_KEY|키|등록되지/i.test(e.message)) break; // 키 문제는 재시도해도 같음
      await new Promise((ok) => setTimeout(ok, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

function normalize(h) {
  return {
    name: h.yadmNm || "",
    type: h.clCdNm || TYPES[h.clCd] || "",
    typeCd: String(h.clCd || ""),
    sggu: h.sgguCdNm || "",
    dong: h.emdongNm || "",
    addr: h.addr || "",
    tel: h.telno || "",
    open: String(h.estbDd || ""),
    docs: Number(h.drTotCnt) || 0,
    url: h.hospUrl || "",
    x: Number(h.XPos) || null,
    y: Number(h.YPos) || null,
  };
}

/**
 * 시·도 하나에서 최근 months개월 안에 개설된 기관 목록.
 * 심평원 API에는 개설일자 조건이 없어서, 종별마다 전체를 받아 개설일자로 거른다.
 */
export async function findNewClinics({ key, sido, months = 3, types = DEFAULT_TYPES, fetchImpl = fetch }) {
  const since = cutoffDate(months);
  const results = await Promise.all(types.map(async (clCd) => {
    const first = await fetchPage({ key, sido, clCd, pageNo: 1, fetchImpl });
    const per = Math.max(first.items.length, 1);
    const pages = first.items.length ? Math.ceil(first.total / per) : 1;
    const rest = await pool(
      Array.from({ length: pages - 1 }, (_, i) => () => fetchPage({ key, sido, clCd, pageNo: i + 2, fetchImpl })),
      CONCURRENCY,
    );
    return [first, ...rest].flatMap((p) => p.items);
  }));
  const scanned = results.reduce((s, r) => s + r.length, 0);
  const items = results.flat().map(normalize)
    .filter((h) => h.open >= since)
    .sort((a, b) => b.open.localeCompare(a.open) || a.name.localeCompare(b.name, "ko"));
  return { since, scanned, items };
}
