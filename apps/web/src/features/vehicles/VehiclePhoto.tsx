import { Icon } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { useUpdateVehicle, type Vehicle } from './useVehicles';

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX = 10 * 1024 * 1024;

/** อัปโหลดรูปรถ (POST /v1/documents kind OTHER → PUT เนื้อไฟล์) → id */
export async function uploadVehiclePhoto(f: File): Promise<string> {
  const mime = IMAGE_MIME.find((m) => m === f.type);
  if (!mime || f.size === 0 || f.size > MAX) throw new Error('bad_file');
  const doc = await unwrap(
    api.POST('/v1/documents', {
      body: { kind: 'OTHER', mime, bytes: f.size, filename: f.name || 'vehicle.jpg' },
    }),
  );
  const u = new URL(doc.uploadUrl!, location.origin);
  const up = await fetch(u.pathname + u.search, { method: 'PUT', body: f });
  if (!up.ok) throw new ApiError((await up.json()) as never);
  return doc.id;
}

/** ลิงก์แสดงรูป (อายุสั้น — GET /v1/documents/{id}) */
function usePhotoUrl(id: string | undefined) {
  return useQuery({
    queryKey: ['documents', id, 'url'],
    enabled: !!id,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const d = await unwrap(api.GET('/v1/documents/{id}', { params: { path: { id: id! } } }));
      if (!d.downloadUrl) return null;
      const u = new URL(d.downloadUrl, location.origin);
      return u.pathname + u.search;
    },
  });
}

/**
 * กรอบ "รูปรถ" ของโปรไฟล์รถ (ต้นแบบ `pr` — กรอบเส้นประ ไอคอนรถ + "รูปรถ") — [DECISION — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ]
 * ต้นแบบไม่มีการอัปโหลด → ผู้มีสิทธิ์ `master:write` กดกรอบเพื่อเลือกรูป (JPEG/PNG/WebP ≤ 10 MB) — รูปใหม่เป็นรูปแรก
 * (`photoDocumentIds` สูงสุด 10 รูปตาม API) · มีรูปแล้ว = แสดงรูปแรกเต็มกรอบ · รถปลดระวาง = อ่านอย่างเดียว (API 409 `vehicle_retired`)
 */
export function VehiclePhoto({
  v,
  canWrite,
  onToast,
}: {
  v: Vehicle;
  canWrite: boolean;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const first = v.photoDocumentIds[0];
  const url = usePhotoUrl(first);
  const update = useUpdateVehicle();
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const editable = canWrite && v.status !== 'retired';

  const pick = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const id = await uploadVehiclePhoto(f);
      await update.mutateAsync({
        id: v.id,
        version: v.version,
        body: { unitRole: v.unitRole, photoDocumentIds: [id, ...v.photoDocumentIds].slice(0, 10) },
      });
      onToast(t('vprof.photoSaved'));
    } catch (e) {
      onToast(
        e instanceof Error && e.message === 'bad_file'
          ? t('vprof.photoBad')
          : (problemText(e, t) ?? t('vprof.photoError')),
      );
    } finally {
      setBusy(false);
    }
  };

  const inner = url.data ? (
    <img
      src={url.data}
      alt={t('vprof.photo')}
      style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10 }}
    />
  ) : (
    <>
      <Icon n="truck" s={40} style={{ color: '#C9CDC3' }} />
      <span>{busy ? t('vprof.photoUploading') : t('vprof.photo')}</span>
      {editable && !busy && (
        <span style={{ color: '#2257C4', fontSize: 12.5 }}>{t('vprof.photoAdd')}</span>
      )}
    </>
  );
  if (!editable)
    return (
      <div className="tms-vprof__photo" data-testid="vprof-photo">
        {inner}
      </div>
    );
  return (
    <>
      <input
        ref={file}
        type="file"
        hidden
        accept={IMAGE_MIME.join(',')}
        data-testid="vprof-photo-input"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <button
        type="button"
        className="tms-vprof__photo"
        data-testid="vprof-photo"
        aria-label={t(first ? 'vprof.photoChange' : 'vprof.photoAdd')}
        title={t(first ? 'vprof.photoChange' : 'vprof.photoAdd')}
        disabled={busy}
        onClick={() => file.current?.click()}
        style={{
          cursor: busy ? 'progress' : 'pointer',
          font: 'inherit',
          padding: url.data ? 0 : undefined,
        }}
      >
        {inner}
      </button>
    </>
  );
}
