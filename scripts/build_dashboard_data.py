"""수집한 TiVA 데이터를 분석해 대시보드용 JSON을 만든다.

    python scripts/build_dashboard_data.py [--data data/processed] [--out docs/data]

계산 지표
    back   후방 참여율 = 총수출 중 해외부가가치 비중 (EXGR_FVASH, 없으면 EXGR_FVA / EXGR)
    fwd    전방 참여율 = 총수출 대비 제3국 수출에 체화된 자국 부가가치 (EXGR_DVAFXSH)
    gvc    GVC 참여율 = back + fwd
    dva_sh 총수출 중 국내부가가치 비중
    int_sh 총수출 중 중간재 비중 (EXGR_INT / EXGR)
    ms     세계 산업 수출 점유율 (EXGR 기준, 개별 경제 합계 대비)
    rca    부가가치 기준 현시비교우위 = (국가 산업 DVA / 국가 전체 DVA) / (세계 산업 DVA / 세계 전체 DVA)
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[1]
log = logging.getLogger("tiva.build")

LEVELS = ["EXGR", "IMGR", "EXGR_INT", "EXGR_DVA", "EXGR_FVA", "VALU", "FFD_DVA", "DFD_FVA"]
SHARES = ["back", "fwd", "gvc", "dva_sh", "int_sh"]
DERIVED = ["ms", "rca"]
COUNTRY_METRICS = LEVELS + SHARES
INDUSTRY_METRICS = ["EXGR", "EXGR_DVA", "EXGR_FVA", "EXGR_INT", "VALU", "FFD_DVA"] + SHARES + DERIVED
PROFILE_METRICS = ["EXGR", "EXGR_DVA", "EXGR_FVA", "VALU"] + SHARES + DERIVED
PARTNER_MEASURES = ["EXGR", "FFD_DVA", "DEXFVApSH", "FEXDVApSH"]
DIGITS = {"rca": 3}


def load_yaml(p):
    with open(p, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def rnd(arr: np.ndarray, metric: str):
    d = DIGITS.get(metric, 2 if metric in SHARES + ["ms"] or metric.endswith("SH") else 1)
    out = []
    for v in np.asarray(arr, dtype="float64").ravel().tolist():
        out.append(None if (v is None or not math.isfinite(v)) else round(v, d))
    return out


def dump(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")


def safe_div(a, b, scale=1.0):
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where((b != 0) & np.isfinite(b), a / b * scale, np.nan)
    return out


class Builder:
    def __init__(self, data_dir: Path, out_dir: Path):
        self.data_dir, self.out = data_dir, out_dir
        self.cfg = load_yaml(ROOT / "config/tiva.yaml")
        self.grp = load_yaml(ROOT / "config/groups.yaml")
        self.manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
        cl_path = data_dir / "codelists.json"
        self.codelists = json.loads(cl_path.read_text(encoding="utf-8")) if cl_path.exists() else {}
        self.qa: dict = {"checks": []}

    # ------------------------------------------------------------- loading
    def _read(self, block: str, cols: dict) -> pd.DataFrame:
        """수집 블록 parquet을 읽어 차원 열 이름을 표준 이름(area, partner, measure, activity)으로 바꾼다."""
        path = self.data_dir / f"tiva_{block}.parquet"
        if not path.exists():
            log.warning("%s 없음", path.name)
            return pd.DataFrame(columns=["area", "partner", "measure", "activity", "year", "value"])
        df = pd.read_parquet(path).rename(columns=cols)
        return df

    def load(self):
        main_cols = {"REF_AREA": "area", "COUNTERPART_AREA": "partner", "MEASURE": "measure", "ACTIVITY": "activity"}
        keep = ["area", "partner", "measure", "activity", "year", "value"]
        ci = self._read("levels", main_cols)[keep]
        sh = self._read("shares", main_cols)
        if not sh.empty:
            blk = self.cfg["blocks"]["shares"]
            pref = blk.get("preferred_unit")
            parts = []
            for m, g in sh.groupby("measure"):
                units = g["UNIT_MEASURE"].value_counts() if "UNIT_MEASURE" in g else pd.Series(dtype=int)
                u = pref if pref in units.index else (units.index[0] if len(units) else None)
                parts.append(g[g["UNIT_MEASURE"] == u] if u is not None else g)
                self.qa.setdefault("share_units", {})[str(m)] = {"used": u, "available": units.index.tolist()}
            sh = pd.concat(parts, ignore_index=True)
            sh["measure"] = sh["measure"].map(lambda m: blk.get("rename", {}).get(m, m))
            ci = pd.concat([ci, sh[keep]], ignore_index=True)
        # 원천 산업 부가가치 중 제3국 수출에 체화된 부분 IV (수집 단계에서 자국을 뺀 합계 FOREIGN으로 줄여 둠)
        fs_ = self._read("forward_source", {"VALUE_ADDED_SOURCE_AREA": "area", "VALUE_ADDED_SOURCE_ACTIVITY": "activity"})
        if not fs_.empty:
            iv = fs_[fs_["EXPORTING_AREA"] == "FOREIGN"].assign(measure="IV", partner="W")
            ci = pd.concat([ci, iv[keep]], ignore_index=True)
        world = self.cfg["codes"]["world"]
        partners = ci["partner"].value_counts()
        if world not in partners.index and len(partners):
            world = partners.index[0]          # 세계 코드가 다르게 쓰인 경우 (예: WLD)
        ci = ci[ci["partner"] == world]
        econ_cfg = self.cfg["codes"]["economies"]
        agg_cfg = self.cfg["codes"]["aggregates"]
        present = set(ci["area"].unique().tolist())
        self.econ = [c for c in econ_cfg if c in present]
        self.aggs = [c for c in agg_cfg if c in present]
        acts_cfg = self.cfg["activities"]["aggregates"] + self.cfg["activities"]["detail"]
        present_acts = set(ci["activity"].unique().tolist())
        self.acts = [a for a in acts_cfg if a in present_acts]
        self.years = sorted(int(y) for y in ci["year"].unique())
        self.latest = int(self.manifest.get("latest_year") or self.years[-1])

        # 국가군(지역) 정의
        self.regions = {}
        for rid, r in self.grp["regions"].items():
            members = [m for m in r["members"] if m in self.econ]
            if members:
                self.regions[f"R_{rid}"] = {**r, "id": rid, "members": members}
        self.areas = self.econ + self.aggs + list(self.regions)
        self.ai = {a: i for i, a in enumerate(self.areas)}
        self.ki = {k: i for i, k in enumerate(self.acts)}
        self.yi = {y: i for i, y in enumerate(self.years)}

        shape = (len(self.areas), len(self.acts), len(self.years))
        wide = ci.pivot_table(index=["area", "activity", "year"], columns="measure", values="value", aggfunc="first")
        idx = wide.index
        a_idx = np.array([self.ai.get(a, -1) for a in idx.get_level_values(0)])
        k_idx = np.array([self.ki.get(k, -1) for k in idx.get_level_values(1)])
        y_idx = np.array([self.yi.get(int(y), -1) for y in idx.get_level_values(2)])
        ok = (a_idx >= 0) & (k_idx >= 0) & (y_idx >= 0)
        self.A: dict[str, np.ndarray] = {}
        for m in wide.columns:
            arr = np.full(shape, np.nan)
            arr[a_idx[ok], k_idx[ok], y_idx[ok]] = wide[m].to_numpy()[ok]
            self.A[m] = arr
        for m in LEVELS + ["IV", "EXGR_DVASH", "EXGR_FVASH", "EXGR_DVAFXSH"]:
            self.A.setdefault(m, np.full(shape, np.nan))
        log.info("국가×산업: 경제 %d, 집계 %d, 산업 %d, 연도 %d~%d", len(self.econ), len(self.aggs), len(self.acts),
                 self.years[0], self.years[-1])

        # 상대국 자료 (모두 백만 달러). 비중은 partner_tables에서 총수출로 나눠 계산한다
        dest = self._read("destination", main_cols)[keep]
        back = self._read("origin_backward", {"EXPORTING_AREA": "area", "VALUE_ADDED_SOURCE_AREA": "partner",
                                              "EXPORTING_ACTIVITY": "activity"})
        back = back.assign(measure="FVA_SRC")[keep] if not back.empty else back.reindex(columns=keep)
        fwd = self._read("origin_forward", {"VALUE_ADDED_SOURCE_AREA": "area", "EXPORTING_AREA": "partner",
                                            "VALUE_ADDED_SOURCE_ACTIVITY": "activity"})
        fwd = fwd.assign(measure="DVA_FX")[keep] if not fwd.empty else fwd.reindex(columns=keep)
        self.pa = pd.concat([x for x in (dest, back, fwd) if not x.empty] or [dest], ignore_index=True)

    # ------------------------------------------------------------- derive
    def derive(self):
        A = self.A
        n_e = len(self.econ)
        reg_slice = slice(len(self.econ) + len(self.aggs), len(self.areas))

        # 지역 합계 (회원국 합)
        for rid, r in self.regions.items():
            i = self.ai[rid]
            idx = [self.ai[m] for m in r["members"]]
            for m in LEVELS + ["IV"]:
                A[m][i] = np.nansum(A[m][idx], axis=0)
                A[m][i][np.all(np.isnan(A[m][idx]), axis=0)] = np.nan

        # 전방 참여율 = IV / 총수출 (Koopman et al. 2010). IV가 없는 TiVA 집계는 전 산업에 한해 공식 FEXGR_DVA를 쓴다
        t_idx = self.ki.get(self.cfg["codes"]["total_activity"])
        fwd = safe_div(A["IV"], A["EXGR"], 100)
        if t_idx is not None:
            off_t = A["EXGR_DVAFXSH"][:, t_idx, :]
            fwd[:, t_idx, :] = np.where(np.isfinite(fwd[:, t_idx, :]), fwd[:, t_idx, :], off_t)
            n = len(self.econ)
            both = np.isfinite(fwd[:n, t_idx, :]) & np.isfinite(off_t[:n]) & (off_t[:n] > 0.5)
            ratio = (fwd[:n, t_idx, :] / np.where(both, off_t[:n], np.nan))[both]
            self.check("전방 참여율 계산값(IV/총수출) ÷ 공식 FEXGR_DVA, 전 산업 (중앙값, 1에 가까워야 함)",
                       float(np.median(ratio)) if ratio.size else None,
                       ok=bool(ratio.size == 0 or 0.97 <= np.median(ratio) <= 1.03))
        A["EXGR_DVAFXSH"] = fwd

        comp_back = safe_div(A["EXGR_FVA"], A["EXGR"], 100)
        comp_dva = safe_div(A["EXGR_DVA"], A["EXGR"], 100)
        back = np.where(np.isfinite(A["EXGR_FVASH"]), A["EXGR_FVASH"], comp_back)
        dva = np.where(np.isfinite(A["EXGR_DVASH"]), A["EXGR_DVASH"], comp_dva)
        back[reg_slice], dva[reg_slice] = comp_back[reg_slice], comp_dva[reg_slice]
        A["back"], A["dva_sh"] = back, dva
        A["fwd"] = A["EXGR_DVAFXSH"]
        A["gvc"] = A["back"] + A["fwd"]
        A["int_sh"] = safe_div(A["EXGR_INT"], A["EXGR"], 100)

        # 품질 점검
        diff = np.abs(comp_back[:n_e] - A["EXGR_FVASH"][:n_e])
        diff = diff[np.isfinite(diff) & (A["EXGR"][:n_e] > 1)]
        self.check("공식 FVA 비중(EXGR_FVASH)과 EXGR_FVA/EXGR 계산값 차이 (%p, 중앙값·최댓값)",
                   [float(np.median(diff)) if diff.size else None, float(diff.max()) if diff.size else None],
                   ok=bool(diff.size == 0 or np.median(diff) < 0.5))
        s = (dva + back)[:n_e]
        s = s[np.isfinite(s)]
        self.check("국내부가가치 비중 + 해외부가가치 비중 (중앙값, 100에 가까워야 함)",
                   float(np.median(s)) if s.size else None, ok=bool(s.size == 0 or abs(np.median(s) - 100) < 2))

        # 세계 합계 = 개별 경제(기타 세계 포함) 합계
        self.world = {}
        for m in ["EXGR", "EXGR_DVA", "EXGR_FVA", "EXGR_INT", "VALU", "FFD_DVA"]:
            self.world[m] = np.nansum(A[m][:n_e], axis=0)
        w_ex = self.world["EXGR"]
        A["ms"] = safe_div(A["EXGR"], w_ex[None], 100)
        A["ms"][len(self.econ):len(self.econ) + len(self.aggs)] = np.nan   # TiVA 집계는 역외 기준이라 제외
        t = self.ki.get(self.cfg["codes"]["total_activity"])
        own_tot = A["EXGR_DVA"][:, t:t + 1, :]
        world_share = safe_div(self.world["EXGR_DVA"], self.world["EXGR_DVA"][t:t + 1, :])
        A["rca"] = safe_div(safe_div(A["EXGR_DVA"], own_tot), world_share[None])
        if "W" in self.ai:
            wi = self.ai["W"]
            off = A["VALU"][wi]
            rel = np.abs(safe_div(off - self.world["VALU"], self.world["VALU"], 100))
            rel = rel[np.isfinite(rel)]
            if rel.size:
                self.check("TiVA 세계(W) 부가가치와 개별 경제 합계의 차이 (%, 중앙값)",
                           float(np.median(rel)), ok=bool(np.median(rel) < 1))

        # 주요국: 부가가치(VALU, 전 산업) 상위 N
        valu = A["VALU"][:n_e, t, self.yi[self.latest]]
        order = [self.econ[i] for i in np.argsort(-np.nan_to_num(valu, nan=-1)) if self.econ[i] != self.cfg["codes"]["rest_of_world"]]
        self.top = order[: self.grp["top_n_by_value_added"]]

    def check(self, name, value, ok=True):
        self.qa["checks"].append({"name": name, "value": value, "ok": ok})
        (log.info if ok else log.warning)("점검 %s: %s %s", "통과" if ok else "주의", name, value)

    # ------------------------------------------------------------- partner
    def partner_tables(self):
        if self.pa.empty:
            self.p_years, self.partners, self.P = [], [], {}
            return
        econ_set = list(self.econ)
        pa = self.pa[self.pa["partner"].isin(econ_set) & self.pa["area"].isin(econ_set)]
        self.p_years = sorted(int(y) for y in pa["year"].unique())
        acts_present = set(pa["activity"].unique().tolist())
        partners_present = set(pa["partner"].unique().tolist())
        self.p_acts = [a for a in self.acts if a in acts_present]
        self.partners = [c for c in self.econ if c in partners_present]
        pi = {p: i for i, p in enumerate(self.partners)}
        pyi = {y: i for i, y in enumerate(self.p_years)}
        pki = {k: i for i, k in enumerate(self.p_acts)}
        shape = (len(self.areas), len(self.p_acts), len(self.p_years), len(self.partners))
        self.P = {}
        for m in ("EXGR", "FFD_DVA", "FVA_SRC", "DVA_FX"):
            sub = pa[pa["measure"] == m]
            arr = np.full(shape, np.nan)
            if not sub.empty:
                a = sub["area"].map(self.ai).to_numpy()
                k = sub["activity"].map(pki).to_numpy()
                y = sub["year"].astype(int).map(pyi).to_numpy()
                p = sub["partner"].map(pi).to_numpy()
                arr[a, k, y, p] = sub["value"].to_numpy()
            self.P[m] = arr

        # 원천별 부가가치(백만 달러)를 해당 경제·산업 총수출 대비 %로 바꾼다. 자기 자신은 제외
        ex = np.stack([self.A["EXGR"][:, self.ki[k], :][:, [self.yi[y] for y in self.p_years]]
                       for k in self.p_acts], axis=1)            # (area, act, year)
        self_mask = np.zeros((len(self.areas), len(self.partners)), dtype=bool)
        for j, p in enumerate(self.partners):
            if p in self.ai:
                self_mask[self.ai[p], j] = True
        for src, dst in (("FVA_SRC", "DEXFVApSH"), ("DVA_FX", "FEXDVApSH")):
            arr = safe_div(self.P[src], ex[..., None], 100)
            arr[np.broadcast_to(self_mask[:, None, None, :], arr.shape)] = np.nan
            self.P[dst] = arr

        # 점검: 원천별 합계가 공식 비중과 맞는지. 후방은 모든 산업, 전방은 전 산업(_T)에서 비교한다.
        # 산업별 전방 연계는 '원천 산업' 기준이라 '수출 산업' 기준인 공식 산업별 전방 참여율과 개념이 다르다.
        n = len(self.econ)
        for m, total, label, acts in (("DEXFVApSH", "EXGR_FVASH", "후방", self.p_acts),
                                      ("FEXDVApSH", "fwd", "전방", self.p_acts)):
            ks = [self.p_acts.index(k) for k in acts if k in self.p_acts]
            if not ks or np.all(np.isnan(self.P[m])):
                continue
            tot = np.stack([self.A[total][:n, self.ki[self.p_acts[k]], :][:, [self.yi[y] for y in self.p_years]]
                            for k in ks], axis=1)
            ssum = np.nansum(self.P[m][:n][:, ks], axis=3)
            valid = np.isfinite(tot) & (tot > 0.5) & (ssum > 0)
            ratio = (ssum / np.where(valid, tot, np.nan))[valid]
            med = float(np.median(ratio)) if ratio.size else None
            self.check(f"원천별 합계 ÷ 공식 {label} 참여율 (중앙값, 1에 가까워야 함)",
                       med, ok=med is None or 0.97 <= med <= 1.03)

        # 지역 합계 (USD 기준으로 더한 뒤 지역 총수출 대비 %로)
        for rid, r in self.regions.items():
            i = self.ai[rid]
            idx = [self.ai[m] for m in r["members"]]
            for m in ("EXGR", "FFD_DVA"):
                self.P[m][i] = np.nansum(self.P[m][idx], axis=0)
            for m in ("DEXFVApSH", "FEXDVApSH"):
                usd = np.nansum(self.P[m][idx] / 100 * ex[idx][..., None], axis=0)
                self.P[m][i] = safe_div(usd, ex[i][..., None], 100)

    # ------------------------------------------------------------- outputs
    def labels(self):
        ko_area = self.grp.get("area_labels", {})
        ko_act = self.grp.get("activity_labels", {})
        en_area = self.codelists.get("area", {})
        en_act = self.codelists.get("activity", {})
        en_area_over = self.grp.get("area_labels_en", {})
        en_act_short = self.grp.get("activity_labels_en", {})
        area = {a: ko_area.get(a) or en_area.get(a) or a for a in self.econ + self.aggs}
        area_en = {a: en_area_over.get(a) or en_area.get(a) or a for a in self.econ + self.aggs}
        for rid, r in self.regions.items():
            area[rid] = r["label"].replace(" 제조업", "") + " (회원국 합계)"
            area_en[rid] = r.get("label_en", r["label"]).replace(" manufacturing", "") + " (sum of members)"
        act = {k: ko_act.get(k) or en_act.get(k) or k for k in self.acts}
        act_en = {k: en_act_short.get(k) or en_act.get(k) or k for k in self.acts}
        return {"area": area, "activity": act, "area_en": area_en, "activity_en": act_en}

    def write(self):
        if self.out.exists():
            for sub in ("industry", "profile", "partner"):
                shutil.rmtree(self.out / sub, ignore_errors=True)
        self.out.mkdir(parents=True, exist_ok=True)
        A = self.A
        t, c = self.ki.get("_T"), self.ki.get("C")
        main_acts = [k for k in ("_T", "C") if k in self.ki]

        detail = [k for k in self.cfg["activities"]["detail"] if k in self.ki]
        meta = {
            "fetched_at": self.manifest.get("fetched_at"),
            "edition": self.manifest.get("edition"),
            "flows": self.manifest.get("flows", []),
            "missing_measures": sorted({c for b in self.manifest.get("missing_codes", {}).values()
                                        for d, cs in b.items() if d == "MEASURE" for c in cs}),
            "years": self.years, "latest": self.latest,
            "partner_years": self.p_years, "partner_acts": getattr(self, "p_acts", []),
            "economies": [e for e in self.econ if e != self.cfg["codes"]["rest_of_world"]],
            "aggregates": self.aggs, "acts": self.acts, "detail_acts": detail,
            "top": self.top,
            "regions": {rid: {"id": r["id"], "label": r["label"], "label_en": r.get("label_en"), "note_en": r.get("note_en"),
                              "subgroup_labels_en": r.get("subgroup_labels_en"), "members": r["members"],
                              "official": r.get("official_aggregate") if r.get("official_aggregate") in self.ai else None,
                              "default_activity": r.get("default_activity", "_T"), "note": r.get("note"),
                              "subgroups": r.get("subgroups")} for rid, r in self.regions.items()},
            "korea": self.grp["korea"],
            "focus": [f for f in self.grp["focus_industries"] if f["code"] in self.ki],
            "labels": self.labels(),
        }
        dump(self.out / "meta.json", meta)

        # 국가·지역별 핵심 시계열 (전 산업, 제조업)
        countries = {"years": self.years, "acts": main_acts, "metrics": COUNTRY_METRICS, "data": {}}
        for a in self.areas:
            i = self.ai[a]
            countries["data"][a] = {k: {m: rnd(A[m][i, self.ki[k]], m) for m in COUNTRY_METRICS} for k in main_acts}
        dump(self.out / "countries.json", countries)

        # 산업별 국가 단면
        n_e = len(self.econ)
        # 집중도(HHI, 상위 3개국 비중)는 '기타 세계'를 제외한 개별 경제로 계산 (분모는 세계 합계)
        ex_all = A["EXGR"][[self.ai[e] for e in self.econ if e != self.cfg["codes"]["rest_of_world"]]]
        for k in self.acts:
            ki = self.ki[k]
            shares = safe_div(ex_all[:, ki], self.world["EXGR"][ki][None])
            hhi = np.nansum(shares ** 2, axis=0) * 10000
            top3 = -np.sort(-np.nan_to_num(shares), axis=0)[:3].sum(axis=0) * 100
            areas = [a for a in self.econ if a != self.cfg["codes"]["rest_of_world"]] + list(self.regions)
            obj = {
                "act": k, "years": self.years, "metrics": INDUSTRY_METRICS,
                "world": {m: rnd(self.world[m][ki], m) for m in self.world},
                "world_back": rnd(safe_div(self.world["EXGR_FVA"][ki], self.world["EXGR"][ki], 100), "back"),
                "hhi": rnd(hhi, "hhi"), "top3": rnd(top3, "ms"),
                "data": {a: {m: rnd(A[m][self.ai[a], ki], m) for m in INDUSTRY_METRICS} for a in areas},
            }
            dump(self.out / "industry" / f"{k}.json", obj)

        # 국가·지역별 산업 단면
        for a in self.areas:
            i = self.ai[a]
            obj = {"area": a, "years": self.years, "metrics": PROFILE_METRICS,
                   "data": {k: {m: rnd(A[m][i, self.ki[k]], m) for m in PROFILE_METRICS} for k in self.acts}}
            dump(self.out / "profile" / f"{a}.json", obj)

        # 상대국별
        if self.P:
            for a in self.econ + list(self.regions):
                i = self.ai[a]
                if a == self.cfg["codes"]["rest_of_world"]:
                    continue
                obj = {"area": a, "years": self.p_years, "acts": self.p_acts, "partners": self.partners, "data": {}}
                for m in PARTNER_MEASURES:
                    obj["data"][m] = {k: [rnd(self.P[m][i, ki, yi], m if m.endswith("SH") else "EXGR")
                                          for yi in range(len(self.p_years))]
                                      for ki, k in enumerate(self.p_acts)}
                dump(self.out / "partner" / f"{a}.json", obj)

        dump(self.out / "qa.json", self.qa)

        # 연구용 요약 CSV (전 산업·제조업 핵심 지표)
        rows = []
        for a in self.econ + self.aggs + list(self.regions):
            for k in main_acts:
                for y in self.years:
                    row = {"area": a, "activity": k, "year": y}
                    for m in COUNTRY_METRICS:
                        v = A[m][self.ai[a], self.ki[k], self.yi[y]]
                        row[m] = None if not np.isfinite(v) else v
                    rows.append(row)
        pd.DataFrame(rows).to_csv(self.data_dir / "country_summary.csv", index=False, float_format="%.4f")
        size = sum(p.stat().st_size for p in self.out.rglob("*.json")) / 1e6
        log.info("대시보드 데이터 작성 완료: %s (%.1f MB)", self.out, size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "data/processed"))
    ap.add_argument("--out", default=str(ROOT / "docs/data"))
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    b = Builder(Path(args.data), Path(args.out))
    b.load()
    b.derive()
    b.partner_tables()
    b.write()


if __name__ == "__main__":
    main()
