import { useRef, useState } from 'react';
import { ApiError } from '../api';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/th';
import {
  currentPosition,
  nowBangkokIso,
  podClientEventId,
  podFailMissing,
  podFailReasons,
  POD_LINK_IMAGE_MIME,
  retryOf,
  uploadPodLinkFile,
  usePodEvent,
  type PodDo,
  type PodEventResult,
  type PodFailKind,
  type PodFailTarget,
  type PodStep,
} from './podLinkApi';

/**
 * Q-LINK แจ้งรับ/ส่งไม่สำเร็จ หรือรับบางส่วน พร้อมเหตุผล + รูป (D-81 · D68-39; docs/01 §3.9, §5.5)
 * [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ] ต้นแบบ TMS Subcon ไม่มีฟอร์มนี้ → ใช้แบบ "ปฏิเสธงาน" ของแท็บงาน
 * (ปุ่มขอบแดง `ofl__reject` → การ์ด: หัวข้อ, ตัวเลือก `ofl__opt`, ปุ่มยืนยันขอบแดง `ofl__decline`, "ย้อนกลับ")
 * + ช่องรายละเอียด/รูป 3 คอลัมน์ "+ เพิ่มรูป" แบบแท็บ "ส่ง POD" · รูปเป็นหลักฐานชุด "ไม่สำเร็จ" ของ DO (`failurePhotos`)
 */
export function PodLinkFail({
  token,
  m,
  target,
  pending,
  onDone,
}: {
  token: string;
  m: PodDo;
  target: PodFailTarget;
  pending: boolean;
  onDone: (r: PodEventResult) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PodFailKind | null>(
    target.kinds.length === 1 ? target.kinds[0]! : null,
  );
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const send = usePodEvent(token);
  const max = m.pod.photosMax;
  const reasons = kind ? podFailReasons(m.failReasons, kind) : [];
  const rsn = reasons.find((r) => r.id === reason);
  const pickup = target.stop.role === 'PICKUP';

  const reset = () => {
    setOpen(false);
    setKind(target.kinds.length === 1 ? target.kinds[0]! : null);
    setReason(null);
    setNote('');
    setPhotos([]);
    setErr(null);
  };

  const pick = async (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    setErr(null);
    const room = max - photos.length;
    if (files.length > room) setErr(t('pdl.pod.maxPhotos', { n: max }));
    setUploading(true);
    try {
      for (const f of files.slice(0, Math.max(room, 0))) {
        const id = await uploadPodLinkFile(token, m.doNo, f, 'POD_PHOTO', f.name || 'fail.jpg');
        setPhotos((x) => [...x, id]);
      }
    } catch (e) {
      setErr(
        e instanceof ApiError && e.problem.status === 429
          ? t('cdl.v.tooMany')
          : e instanceof ApiError && e.problem.code === 'pod_exists'
            ? t('pdl.pod.e.exists')
            : t('pdl.pod.badFile'),
      );
    } finally {
      setUploading(false);
    }
  };

  const errText = (e: unknown): string => {
    if (e instanceof Error && e.message === 'bad_file') return t('pdl.pod.badFile');
    if (!(e instanceof ApiError)) return t('pdl.e.failed');
    const p = e.problem as { status: number; code?: string; errors?: { code?: string }[] };
    if (p.status === 429) return t('cdl.v.tooMany');
    const codes = p.errors ?? [];
    if (codes.some((x) => x.code === 'photo_required')) return t('pdl.q.e.photo');
    if (codes.some((x) => x.code === 'required' || x.code === 'note_required'))
      return t('pdl.q.e.note');
    if (p.code === 'pod_exists') return t('pdl.pod.e.exists');
    if (p.code === 'stop_not_arrived') return t('pdl.pod.e.notArrived');
    if (p.code === 'stop_not_ready') return t('pdl.pod.e.notReady');
    if (p.code === 'stop_already_closed') return t('pdl.pod.e.alreadyClosed');
    if (p.code === 'trip_not_in_progress') return t('pdl.e.notInProgress');
    return t('pdl.e.failed');
  };

  const submit = async () => {
    if (sending.current || uploading) return;
    const miss = podFailMissing(kind, rsn, note, photos.length);
    if (miss) {
      setErr(
        t(
          (
            {
              kind: 'pdl.f.e.kind',
              reason: 'pdl.f.e.reason',
              note: 'pdl.q.e.note',
              photo: 'pdl.q.e.photo',
            } as const
          )[miss],
        ),
      );
      return;
    }
    const k = kind!;
    sending.current = true;
    setErr(null);
    try {
      const step: PodStep = { stopId: target.stop.id, type: k.type };
      const pos = await currentPosition();
      const r = await send.mutateAsync({
        stopId: step.stopId,
        body: {
          type: k.type,
          ...(k.outcome ? { outcome: k.outcome } : {}),
          reasonCodeId: rsn!.id,
          ...(note.trim() ? { note: note.trim() } : {}),
          // คงที่ต่อ (ลิงก์, จุด, ชนิด, ผล) — เน็ตหลุดแล้วกดใหม่ได้ผลเดิม
          clientEventId: await podClientEventId(
            token,
            step,
            retryOf(m, step),
            `fail:${k.outcome ?? 'FAILED'}`,
          ),
          occurredAt: nowBangkokIso(),
          ...(k.photos && photos.length
            ? { failurePhotos: { doNo: m.doNo, photoDocumentIds: photos } }
            : {}),
          ...(pos ?? {}),
        },
      });
      reset();
      onDone(r);
    } catch (e) {
      setErr(errText(e));
    } finally {
      sending.current = false;
    }
  };

  if (!open)
    return (
      <button
        type="button"
        className="ofl__reject"
        data-testid="pdl-fail-open"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {t('pdl.f.open')}
      </button>
    );

  return (
    <div className="cdl__card" data-testid="pdl-fail">
      <span style={{ fontWeight: 600 }}>{t(pickup ? 'pdl.f.titlePickup' : 'pdl.f.titleDrop')}</span>
      <span className="cdl__muted">{target.stop.siteName}</span>
      {target.kinds.length > 1 &&
        target.kinds.map((k) => (
          <button
            key={k.key}
            type="button"
            className="ofl__opt"
            aria-pressed={kind?.key === k.key}
            onClick={() => {
              setKind(k);
              // เหตุผลที่ไม่อยู่ในชุดของตัวเลือกใหม่ล้างออก
              if (!podFailReasons(m.failReasons, k).some((r) => r.id === reason)) setReason(null);
              setErr(null);
            }}
          >
            {t(`pdl.f.kind.${k.key}` as MessageKey)}
          </button>
        ))}
      {kind && (
        <div className="cdl__label" data-testid="pdl-fail-reasons">
          <span>{t('pdl.f.reason')}</span>
          {reasons.length === 0 && <span className="cdl__muted">{t('pdl.f.noReasons')}</span>}
          {reasons.map((r) => (
            <button
              key={r.id}
              type="button"
              className="ofl__opt"
              aria-pressed={reason === r.id}
              onClick={() => {
                setReason(r.id);
                setErr(null);
              }}
            >
              {/* ชื่อซ้ำข้ามหมวด (เช่น "อื่น ๆ") → ต่อท้ายหมวดปฏิเสธรับ */}
              {reasons.some((x) => x.id !== r.id && x.label === r.label) &&
              r.category === 'REJECTED_BY_RECEIVER'
                ? t('pdl.f.refused', { l: r.label })
                : r.label}
            </button>
          ))}
        </div>
      )}
      {kind && (
        <label className="cdl__label">
          <span>{t(rsn?.requiresNote ? 'pdl.f.noteReq' : 'pdl.f.note')}</span>
          <textarea
            className="cdl__input pdl__area"
            maxLength={500}
            data-testid="pdl-fail-note"
            placeholder={t('pdl.f.notePh')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      )}
      {kind?.photos && (
        <div className="cdl__label">
          <span>{t(rsn?.requiresPhoto ? 'pdl.f.photosReq' : 'pdl.f.photos')}</span>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept={POD_LINK_IMAGE_MIME.join(',')}
            data-testid="pdl-fail-photo-input"
            onChange={(e) => void pick(e.target.files)}
          />
          <div className="cdl__photos" data-testid="pdl-fail-photos">
            {photos.map((id, i) => (
              <div key={id} className="cdl__photo pdl__photo">
                {t('pdl.pod.photoN', { n: i + 1 })}
                <button
                  type="button"
                  className="pdl__x"
                  aria-label={t('pdl.pod.remove', { n: i + 1 })}
                  title={t('pdl.pod.remove', { n: i + 1 })}
                  onClick={() => setPhotos((x) => x.filter((y) => y !== id))}
                >
                  ×
                </button>
              </div>
            ))}
            {photos.length < max && (
              <button
                type="button"
                className="cdl__add"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? t('pdl.pod.uploading') : t('pdl.pod.add')}
              </button>
            )}
          </div>
        </div>
      )}
      {err && (
        <span className="cdl__err" role="alert" data-testid="pdl-fail-err">
          {err}
        </span>
      )}
      <button
        type="button"
        className="ofl__decline"
        data-testid="pdl-fail-ok"
        disabled={send.isPending || uploading}
        style={{ opacity: kind && rsn ? 1 : 0.5 }}
        onClick={() => void submit()}
      >
        {t('pdl.f.ok')}
      </button>
      <button type="button" className="cdl__ghost" onClick={reset}>
        {t('ofl.back')}
      </button>
    </div>
  );
}
