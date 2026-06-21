interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'ok' | 'err' | 'warn' | 'accent';
}

export default function StatCard({ label, value, hint, tone = 'default' }: StatCardProps) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <small className="stat-hint">{hint}</small>}
    </div>
  );
}
