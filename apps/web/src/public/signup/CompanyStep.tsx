import { isValidThaiTaxId } from '@tms/domain';
import { Building2, Database, Info, Search, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/core';
import type { MessageKey } from '../../i18n/th';
import {
  ACCOUNTING_SOFTWARE,
  ADDRESS_KEYS,
  signupApi,
  SignupError,
  type CompanyAddress,
  type CompanyLookupResult,
  type SignupSession,
} from './signupApi';

/**
 * สมัครขั้น 2 "ข้อมูลบริษัท" (P1-ST2-T04) — `design/prototype/TMS Signup.dc.html` view `signup` (su.s2 / co.*)
 *
 * ต่างจากต้นแบบ [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (spec/12 §3 แถว "สมัครขั้น 2"):
 * - ป้ายแหล่งข้อมูล = "ข้อมูลจากกรมสรรพากร" (แหล่งจริง — spec/12 §3 แถว "แหล่งข้อมูลบริษัทตอนสมัคร") · กล่อง "ไม่พบ" อ้างกรมสรรพากร
 *   และแยกข้อความ ไม่จด VAT / ไม่พบ / ค้นไม่ได้ตอนนี้ / บุคคลธรรมดา (สไตล์กล่องเดียวกับต้นแบบ)
 * - ที่อยู่แยก 8 ช่อง (spec/01 §2 ขั้น 2) แทน textarea ช่องเดียว — หัวข้อ "ที่อยู่ออกใบกำกับภาษี" + ช่องแบบเดียวกับต้นแบบ
 * - ช่องแนบหนังสือรับรอง (ต้นแบบไม่มี — PO 24 พ.ย. ประกอบจากโครงสร้างต้นแบบ): แสดงเมื่อค้นแล้วไม่พบผู้จด VAT
 *   บังคับเมื่อ pending_manual · ปุ่มสไตล์ "ค้นหา"
 * - checksum (PLT-020) ตรวจทันทีเมื่อพิมพ์ครบ 13 หลัก — ผิด = error ไม่ส่งคำขอ
 * - จำนวนรถเริ่มว่าง — ค่า 20/8 ของต้นแบบใช้เป็น placeholder · "ย้อนกลับ" ที่ขั้น 2 แสดงขั้น 1 แบบอ่านอย่างเดียว (SignupMain)
 * - หนังสือรับรองบังคับเฉพาะ tin_exists (pending_manual — PLT-021) · ไม่พบ/ค้นไม่ได้/บุคคลธรรมดา แนบได้ไม่บังคับ
 * - ธง same_tax_other_branch (PLT-022 "แนะนำเพิ่มสาขาใน tenant เดิม") ไม่แสดง — ต้นแบบไม่มีช่อง (spec/12 §3)
 */
type Status = CompanyLookupResult['result'] | 'manual';
const NOTE: Partial<Record<Status, MessageKey>> = {
  tin_exists: 'su.s2.tinOnly',
  not_found: 'su.s2.nf',
  unavailable: 'su.s2.unavailable',
  manual: 'su.s2.unavailable',
  individual: 'su.s2.individual',
};
const EMPTY_ADDR: CompanyAddress = {
  houseNo: '',
  moo: '',
  soi: '',
  street: '',
  subDistrict: '',
  district: '',
  province: '',
  postalCode: '',
};
const REQUIRED_ADDR: Array<keyof CompanyAddress> = [
  'houseNo',
  'subDistrict',
  'district',
  'province',
  'postalCode',
];
const CERT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

export interface CompanyStep {
  body: ReactNode;
  /** แสดงปุ่ม "ถัดไป" (ต้นแบบซ่อนเมื่อเลขซ้ำ) */
  showNext: boolean;
  next: () => Promise<void>;
  busy: boolean;
}

export function useCompanyStep(opts: {
  session: SignupSession | null;
  active: boolean;
  onSession: (s: SignupSession) => void;
  onToast: (m: string) => void;
  problemText: (e: unknown) => string;
}): CompanyStep {
  const { t } = useI18n();
  const { session, active, onSession, onToast, problemText } = opts;
  const [tax, setTax] = useState('');
  const [taxErr, setTaxErr] = useState('');
  const [found, setFound] = useState<CompanyLookupResult | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState('');
  const [addr, setAddr] = useState<CompanyAddress>(EMPTY_ADDR);
  const [br, setBr] = useState<'hq' | 'br'>('hq');
  const [brNo, setBrNo] = useState('');
  const [own, setOwn] = useState('');
  const [sub, setSub] = useState('');
  const [acc, setAcc] = useState<(typeof ACCOUNTING_SOFTWARE)[number]>('none');
  const [cons, setCons] = useState({ terms: false, pdpa: false, mk: false });
  const [cErr, setCErr] = useState('');
  const [certErr, setCertErr] = useState('');
  const [bad, setBad] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const prefilled = useRef(false);

  // ย้อนกลับมาแก้ (ขั้น 3 → 2) / กลับมาทำต่อ: เติมจากข้อมูลที่ส่งแล้ว แล้วค้นซ้ำ (ผลจาก cache — ไม่ส่งเลขออกใหม่ถ้ายังไม่หมดอายุ)
  useEffect(() => {
    const c = session?.company;
    if (!active || !c || prefilled.current) return;
    prefilled.current = true;
    setTax(c.taxId);
    setBr(c.branchCode === '00000' ? 'hq' : 'br');
    setBrNo(c.branchCode === '00000' ? '' : c.branchCode);
    setName(c.legalName ?? '');
    setAddr({ ...EMPTY_ADDR, ...(c.address ?? {}) });
    setOwn(c.fleetSizeOwn === null ? '' : String(c.fleetSizeOwn));
    setSub(c.fleetSizeSubcon === null ? '' : String(c.fleetSizeSubcon));
    if (c.accountingSoftware) setAcc(c.accountingSoftware as (typeof ACCOUNTING_SOFTWARE)[number]);
    setCons({ terms: true, pdpa: true, mk: c.marketingOptIn });
    void signupApi
      .lookup(c.taxId, c.branchCode)
      .then((r) => {
        setFound(r);
        setStatus(r.result);
      })
      .catch(() => setStatus('manual'));
  }, [active, session?.company]);

  const taxOk = /^\d{13}$/.test(tax);
  const form = !!status && status !== 'duplicate';
  const certificate = session?.certificate ?? null;
  const needCert = !!found?.requiresCertificate;

  const onTax = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 13);
    setTax(d);
    setFound(null);
    setStatus(null);
    // PLT-020: ครบ 13 หลักตรวจ checksum ทันที (ไม่ส่งคำขอ)
    setTaxErr(d.length === 13 && !isValidThaiTaxId(d) ? t('su.s2.err.taxChecksum') : '');
  };

  async function find() {
    if (!taxOk) {
      setTaxErr(t('su.s2.err.taxDigits'));
      return;
    }
    if (!isValidThaiTaxId(tax)) {
      setTaxErr(t('su.s2.err.taxChecksum'));
      return;
    }
    setBusy(true);
    try {
      const r = await signupApi.lookup(tax, br === 'br' && /^\d{5}$/.test(brNo) ? brNo : '00000');
      setFound(r);
      setStatus(r.result);
      setTaxErr('');
      if (r.result === 'vat_found' && r.company) {
        setName(r.company.legalName);
        setAddr({ ...EMPTY_ADDR, ...r.company.address });
      } else if (r.result !== 'duplicate') {
        setName('');
        setAddr(EMPTY_ADDR);
      }
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      if (p?.code === 'signup_lookup_limit') {
        // เกินเพดานค้นหา — กรอกเองต่อได้
        setFound(null);
        setStatus('manual');
        onToast(problemText(e));
      } else if (p?.code === 'validation_failed') setTaxErr(t('su.s2.err.taxChecksum'));
      else setTaxErr(problemText(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(f: File | undefined) {
    if (!f) return;
    if (!CERT_TYPES.includes(f.type) || f.size > 10 * 1024 * 1024) {
      setCertErr(t('su.s2.err.certType'));
      return;
    }
    setBusy(true);
    try {
      onSession(await signupApi.uploadCertificate(f));
      setCertErr('');
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      setCertErr(p?.code === 'validation_failed' ? t('su.s2.err.certType') : problemText(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function join(kind: 'join' | 'contact') {
    setBusy(true);
    try {
      const s = await signupApi.joinRequest(tax, found?.branchCode ?? '00000', kind);
      if (kind === 'contact') onToast(t('su.s2.contactSent'));
      onSession(s);
    } catch (e) {
      onToast(problemText(e));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    if (!taxOk) {
      setTaxErr(t('su.s2.err.taxDigits'));
      return;
    }
    if (!isValidThaiTaxId(tax)) {
      setTaxErr(t('su.s2.err.taxChecksum'));
      return;
    }
    if (!status) {
      setTaxErr(t('su.s2.err.findFirst'));
      return;
    }
    if (status === 'duplicate') return;
    const miss = new Set<string>();
    if (!name.trim()) miss.add('name');
    for (const k of REQUIRED_ADDR) if (!addr[k].trim()) miss.add(k);
    if (miss.size) {
      setBad(miss);
      onToast(t('su.s2.err.nameAddr'));
      return;
    }
    if (!/^\d{5}$/.test(addr.postalCode)) {
      setBad(new Set(['postalCode']));
      onToast(t('su.s2.err.postal'));
      return;
    }
    if (br === 'br' && !/^(?!00000)\d{5}$/.test(brNo)) {
      setBad(new Set(['brNo']));
      onToast(t('su.s2.err.branchNo'));
      return;
    }
    const nOwn = Number(own);
    const nSub = Number(sub);
    if (own === '' || sub === '' || nOwn > 5000 || nSub > 5000) {
      setBad(new Set([own === '' || nOwn > 5000 ? 'own' : 'sub']));
      onToast(t('su.s2.err.fleet'));
      return;
    }
    if (needCert && !certificate) {
      setCertErr(t('su.s2.err.cert'));
      return;
    }
    if (!cons.terms || !cons.pdpa) {
      setCErr(t('su.s2.err.consent'));
      return;
    }
    setBad(new Set());
    setBusy(true);
    try {
      const s = await signupApi.submitCompany({
        taxId: tax,
        branchType: br === 'hq' ? 'hq' : 'branch',
        ...(br === 'br' ? { branchCode: brNo } : {}),
        legalName: name.trim(),
        address: addr,
        fleetSizeOwn: nOwn,
        fleetSizeSubcon: nSub,
        accountingSoftware: acc,
        acceptTerms: true,
        acceptPrivacy: true,
        marketingOptIn: cons.mk,
      });
      prefilled.current = true;
      onSession(s);
    } catch (e) {
      const p = e instanceof SignupError ? e.problem : null;
      if (p?.code === 'company_exists') {
        // เลข/สาขานี้ใช้ TMS อยู่แล้ว → แสดงกล่องเลขซ้ำ (ค้นซ้ำด้วยสาขาที่เลือก)
        const r = await signupApi.lookup(tax, br === 'hq' ? '00000' : brNo).catch(() => null);
        if (r) {
          setFound(r);
          setStatus(r.result);
        }
      } else if (p?.errors?.some((x) => x.code === 'certificate_required')) {
        setCertErr(t('su.s2.err.cert'));
      } else onToast(problemText(e));
    } finally {
      setBusy(false);
    }
  }

  const pill = (on: boolean) => `su-pill${on ? ' is-on' : ''}`;
  const input = (k: string) => `su-in${bad.has(k) ? ' is-err' : ''}`;
  const clearBad = (k: string) =>
    setBad((z) => {
      if (!z.has(k)) return z;
      const n = new Set(z);
      n.delete(k);
      return n;
    });
  const dup = status === 'duplicate' ? found?.duplicate : null;
  const note = status ? NOTE[status] : undefined;

  const body = (
    <>
      <div className="su-head">
        <h1>{t('su.s2.title')}</h1>
        <span>{t('su.s2.sub')}</span>
      </div>
      <label className="su-field su-field--wide">
        <span className="su-label">
          {t('su.s2.tax')}
          <span className="su-req"> *</span>
        </span>
        <div className="su-tax">
          <input
            className={`su-in su-tax__in${taxErr ? ' is-err' : ''}`}
            value={tax}
            onChange={(e) => onTax(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void find();
            }}
            inputMode="numeric"
            maxLength={13}
            placeholder={t('su.s2.taxPh')}
            aria-invalid={taxErr ? true : undefined}
          />
          <button type="button" className="su-find" disabled={busy} onClick={() => void find()}>
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            {t('su.s2.find')}
          </button>
        </div>
        {taxErr && (
          <span className="su-err" role="alert">
            {taxErr}
          </span>
        )}
      </label>
      {dup && (
        <div className="su-dup" role="status">
          <span className="su-dup__t">
            <Building2 size={18} strokeWidth={1.8} aria-hidden="true" />
            {t('su.s2.dupTitle', {
              name: dup.branchLabel ? `${dup.companyName} (${dup.branchLabel})` : dup.companyName,
            })}
          </span>
          <span className="su-dup__d">{t('su.s2.dupBody')}</span>
          <div className="su-dup__row">
            <button
              type="button"
              className="su-btn su-btn--pri"
              disabled={busy}
              onClick={() => void join('join')}
            >
              {t('su.s2.join')}
            </button>
            <button
              type="button"
              className="su-btn su-btn--sec"
              disabled={busy}
              onClick={() => void join('contact')}
            >
              {t('su.s2.contact')}
            </button>
          </div>
        </div>
      )}
      {form && (
        <>
          {status === 'vat_found' && (
            <span className="su-src">
              <Database size={12} strokeWidth={1.8} aria-hidden="true" />
              {t('su.s2.srcRd')}
            </span>
          )}
          {note && (
            <div className="su-note" role="status">
              <Info size={16} strokeWidth={1.8} className="su-note__i" aria-hidden="true" />
              <span>{t(note)}</span>
            </div>
          )}
          <div className="su-fields">
            <label className="su-field su-field--wide">
              <span className="su-label">
                {t('su.s2.name')}
                <span className="su-req"> *</span>
              </span>
              <input
                className={input('name')}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearBad('name');
                }}
              />
            </label>
            <span className="su-label su-field--wide su-group">
              {t('su.s2.addr')}
              <span className="su-req"> *</span>
            </span>
            {ADDRESS_KEYS.map((k) => (
              <label key={k} className="su-field">
                <span className="su-label">
                  {t(`su.s2.a.${k}` as MessageKey)}
                  {REQUIRED_ADDR.includes(k) && <span className="su-req"> *</span>}
                </span>
                <input
                  className={input(k)}
                  value={addr[k]}
                  inputMode={k === 'postalCode' ? 'numeric' : undefined}
                  maxLength={k === 'postalCode' ? 5 : undefined}
                  onChange={(e) => {
                    const v =
                      k === 'postalCode' ? e.target.value.replace(/\D/g, '') : e.target.value;
                    setAddr((z) => ({ ...z, [k]: v }));
                    clearBad(k);
                  }}
                />
              </label>
            ))}
            <div className="su-field su-field--wide">
              <span className="su-label">{t('su.s2.branch')}</span>
              <div className="su-pills">
                {(
                  [
                    ['hq', 'su.s2.hq'],
                    ['br', 'su.s2.br'],
                  ] as const
                ).map(([k, l]) => (
                  <button
                    key={k}
                    type="button"
                    className={pill(br === k)}
                    aria-pressed={br === k}
                    onClick={() => setBr(k)}
                  >
                    {t(l)}
                  </button>
                ))}
                {br === 'br' && (
                  <input
                    className={`su-brno${bad.has('brNo') ? ' is-err' : ''}`}
                    value={brNo}
                    onChange={(e) => {
                      setBrNo(e.target.value.replace(/\D/g, '').slice(0, 5));
                      clearBad('brNo');
                    }}
                    maxLength={5}
                    placeholder={t('su.s2.brPh')}
                    inputMode="numeric"
                    aria-label={t('su.s2.br')}
                  />
                )}
              </div>
            </div>
            <label className="su-field">
              <span className="su-label">{t('su.s2.own')}</span>
              <input
                className={`${input('own')} su-num`}
                value={own}
                placeholder="20"
                inputMode="numeric"
                onChange={(e) => {
                  setOwn(e.target.value.replace(/\D/g, '').slice(0, 4));
                  clearBad('own');
                }}
              />
            </label>
            <label className="su-field">
              <span className="su-label">{t('su.s2.subcon')}</span>
              <input
                className={`${input('sub')} su-num`}
                value={sub}
                placeholder="8"
                inputMode="numeric"
                onChange={(e) => {
                  setSub(e.target.value.replace(/\D/g, '').slice(0, 4));
                  clearBad('sub');
                }}
              />
            </label>
            <div className="su-field su-field--wide">
              <span className="su-label">{t('su.s2.acc')}</span>
              <div className="su-pills">
                {ACCOUNTING_SOFTWARE.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={pill(acc === a)}
                    aria-pressed={acc === a}
                    onClick={() => setAcc(a)}
                  >
                    {t(`su.s2.acc.${a}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>
            {(needCert || certificate || (status && status !== 'vat_found')) && (
              <div className="su-field su-field--wide">
                <span className="su-label">
                  {t('su.s2.cert')}
                  {needCert && <span className="su-req"> *</span>}
                </span>
                <div className="su-pills">
                  <button
                    type="button"
                    className="su-find su-find--sm"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload size={16} strokeWidth={1.8} aria-hidden="true" />
                    {certificate ? t('su.s2.certChange') : t('su.s2.certPick')}
                  </button>
                  {certificate && <span className="su-file">{certificate.filename ?? ''}</span>}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    hidden
                    aria-label={t('su.s2.cert')}
                    onChange={(e) => void pickFile(e.target.files?.[0])}
                  />
                </div>
                {certErr ? (
                  <span className="su-err" role="alert">
                    {certErr}
                  </span>
                ) : (
                  <span className="su-hint">{t('su.s2.certHint')}</span>
                )}
              </div>
            )}
          </div>
          <div className="su-consent">
            {(
              [
                ['terms', 'su.s2.c.terms', true],
                ['pdpa', 'su.s2.c.pdpa', true],
                ['mk', 'su.s2.c.mk', false],
              ] as const
            ).map(([k, l, req]) => (
              <label key={k} className="su-check">
                <input
                  type="checkbox"
                  checked={cons[k]}
                  onChange={() => {
                    setCons((z) => ({ ...z, [k]: !z[k] }));
                    setCErr('');
                  }}
                />
                <span>
                  {t(l)}
                  {req && <span className="su-req"> *</span>}
                </span>
              </label>
            ))}
            {cErr && (
              <span className="su-err" role="alert">
                {cErr}
              </span>
            )}
          </div>
        </>
      )}
    </>
  );

  return { body, showNext: status !== 'duplicate', next, busy };
}
