import type { components } from '@tms/contracts';
import { Badge, ReasonDialog } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import { problemText } from '../master/problems';
import { RowMenu } from './UserActions';

export type JoinRequest = components['schemas']['JoinRequestDto'];

/**
 * P1-ST2-T06 คำขอเข้าร่วมบริษัท (spec/01 PLT-107) — ต้นแบบ TMS v4 ไม่มีส่วนนี้ → ประกอบจากตารางผู้ใช้เดิม
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้ · spec/12 §3]: แถวบนสุดของตาราง "ผู้ใช้" (ป้าย "ขอเข้าร่วม") + เมนู ⋮ เดิม
 * - "เชิญเข้าบริษัท" = ฟอร์มเชิญผู้ใช้เดิม กรอกชื่อ/อีเมลให้ (เลือกบทบาท + ยืนยัน 2FA ตามการเชิญปกติ) → API ปิดคำขอเป็นอนุมัติ
 * - "ปฏิเสธ" = ReasonDialog (เหตุผล ≥ 10 ตัว — ส่งถึงผู้ขอทางอีเมล + audit)
 */
export function useJoinRequests(enabled: boolean) {
  return useQuery({
    queryKey: ['users', 'join-requests'],
    queryFn: () => unwrap(api.GET('/v1/users/join-requests')),
    enabled,
  });
}

export function JoinRequestRows({
  rows,
  canWrite,
  onInvite,
  onDecline,
}: {
  rows: JoinRequest[];
  canWrite: boolean;
  onInvite: (j: JoinRequest) => void;
  onDecline: (j: JoinRequest) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <>
      {rows.map((j) => (
        <tr key={j.id} data-join-request={j.id}>
          <td>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.4 }}>
              <span style={{ fontWeight: 500 }}>{j.applicantName}</span>
              <span style={{ color: '#3B424C' }}>{j.email}</span>
            </div>
          </td>
          <td>
            <Badge label={t('users.join.badge')} tone="info" icon="user-plus" />
          </td>
          <td>
            {j.status === 'pending' ? (
              <Badge label={t('users.join.escalated')} tone="warn" icon="clock" />
            ) : (
              <span style={{ color: '#3B424C' }}>
                {j.ownerDueAt
                  ? t('users.join.due', { d: formatDateTime(j.ownerDueAt, lang) })
                  : '—'}
              </span>
            )}
          </td>
          <td style={{ color: '#3B424C' }}>{formatDateTime(j.createdAt, lang)}</td>
          <td className="c">
            {canWrite && (
              <RowMenu
                label={t('table.rowActions')}
                items={[
                  { label: t('users.join.invite'), icon: 'user-plus', run: () => onInvite(j) },
                  { label: t('users.join.decline'), icon: 'x', run: () => onDecline(j) },
                ]}
              />
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

export function DeclineJoinDialog({
  request,
  onClose,
  onDone,
}: {
  request: JoinRequest | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: ({ j, reason }: { j: JoinRequest; reason: string }) =>
      unwrap(
        api.POST('/v1/users/join-requests/{id}/decline', {
          params: { path: { id: j.id } },
          body: { reason },
        }),
      ),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['users', 'join-requests'] });
      onDone(t('users.join.declined', { n: v.j.applicantName }));
    },
  });
  return (
    <ReasonDialog
      open={!!request}
      title={request ? t('users.join.declineT', { n: request.applicantName }) : ''}
      description={t('users.join.declineD')}
      label={t('users.reason')}
      placeholder={t('users.reasonPh')}
      okLabel={t('users.join.decline')}
      okIcon="x"
      hint={(n, ok) => (ok ? t('con.reasonOk') : t('ord.dlg.hintMin', { n }))}
      cancelLabel={t('common.cancel')}
      closeLabel={t('drawer.close')}
      busy={run.isPending}
      error={problemText(run.error, t)}
      onClose={() => {
        run.reset();
        onClose();
      }}
      onOk={(reason) => request && run.mutate({ j: request, reason })}
    />
  );
}
