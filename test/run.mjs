// 심평원 응답을 흉내 낸 가짜 데이터로 lib/hira.js를 검사한다 (인증키·네트워크 불필요).
import assert from "node:assert/strict";
import { parseResponse, findNewClinics, cutoffDate } from "../lib/hira.js";

const ymd = (daysAgo) => {
  const d = new Date(Date.now() + 9 * 3600e3 - daysAgo * 864e5);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};

// 의원(31) 2,350곳: 3페이지. 그중 일부만 최근 개설
function fakeHospitals(clCd, n) {
  return Array.from({ length: n }, (_, i) => ({
    yadmNm: `테스트${clCd}-${i}`, clCd, clCdNm: clCd === "31" ? "의원" : "병원",
    sgguCdNm: i % 2 ? "대구수성구" : "대구중구", addr: `대구 어딘가 ${i}`, telno: "053-000-0000",
    estbDd: i < 40 ? ymd(i * 2) : "20100101", drTotCnt: 1, XPos: "128.6", YPos: "35.8",
  }));
}
const DB = { "31": fakeHospitals("31", 2350), "21": fakeHospitals("21", 7) };
let calls = 0;
const fakeFetch = async (url) => {
  calls++;
  const u = new URL(url);
  const clCd = u.searchParams.get("clCd"), page = +u.searchParams.get("pageNo"), rows = +u.searchParams.get("numOfRows");
  const all = DB[clCd] || [];
  const slice = all.slice((page - 1) * rows, page * rows);
  const body = { response: { header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: { items: slice.length === 1 ? { item: slice[0] } : slice.length ? { item: slice } : "", totalCount: all.length, pageNo: page, numOfRows: rows } } };
  return new Response(JSON.stringify(body), { status: 200 });
};

// 1) 페이지를 모두 돌고 개설일자로 거르는지
const r = await findNewClinics({ key: "test", sido: "230000", months: 3, types: ["31", "21"], fetchImpl: fakeFetch });
assert.equal(r.scanned, 2357, "모든 페이지를 받아야 함");
assert.equal(calls, 4, "의원 3페이지 + 병원 1페이지");
const expected = [...DB["31"], ...DB["21"]].filter((h) => h.estbDd >= cutoffDate(3)).length;
assert.equal(r.items.length, expected);
assert.ok(r.items.every((h, i, a) => i === 0 || a[i - 1].open >= h.open), "최신 개설순 정렬");
console.log(`✓ 페이지 순회·필터·정렬 (${r.items.length}곳 / ${r.scanned}곳 중)`);

// 2) XML 응답과 오류 응답 해석
const xml = `<response><header><resultCode>00</resultCode></header><body><items><item><yadmNm>가나의원</yadmNm><estbDd>20261001</estbDd></item></items><totalCount>1</totalCount></body></response>`;
const px = parseResponse(xml);
assert.equal(px.total, 1); assert.equal(px.items[0].yadmNm, "가나의원");
assert.throws(() => parseResponse(`<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>`), /SERVICE_KEY/);
assert.throws(() => parseResponse(JSON.stringify({ response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED" } } })), /30/);
console.log("✓ XML·JSON 응답과 인증키 오류 해석");

// 3) 기준일 계산
assert.match(cutoffDate(3), /^\d{8}$/);
console.log("✓ 기준일", cutoffDate(3));
console.log("모든 검사 통과");
