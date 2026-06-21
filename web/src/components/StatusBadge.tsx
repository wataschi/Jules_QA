import { statusLabel } from '../api';

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`badge badge-${status}`}>
      {statusLabel(status)}
    </span>
  );
}
