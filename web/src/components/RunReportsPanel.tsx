import type { RunDetail } from '../api';

interface Props {
  reportPaths: NonNullable<RunDetail['reportPaths']>;
}

function reportFileName(url: string): string {
  return decodeURIComponent(url.split('/').pop() ?? url);
}

export default function RunReportsPanel({ reportPaths }: Props) {
  const hasPlaywright = Boolean(reportPaths.playwright);
  const hasMidscene = Boolean(reportPaths.midscene?.length);
  const hasVideos = Boolean(reportPaths.videos?.length);
  const hasPlans = Boolean(reportPaths.plans?.length);
  const hasAny = hasPlaywright || hasMidscene || hasVideos || hasPlans;

  if (!hasAny) return null;

  return (
    <div className="run-reports">
      {hasPlaywright && (
        <section className="report-block">
          <div className="report-block-head">
            <h2>Playwright</h2>
            <a href={reportPaths.playwright} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Відкрити окремо
            </a>
          </div>
          <iframe
            className="report-frame"
            title="Playwright report"
            src={reportPaths.playwright}
            loading="lazy"
          />
        </section>
      )}

      {hasMidscene &&
        reportPaths.midscene!.map((src) => (
          <section key={src} className="report-block">
            <div className="report-block-head">
              <h2>Midscene — {reportFileName(src)}</h2>
              <a href={src} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                Відкрити окремо
              </a>
            </div>
            <iframe className="report-frame" title={`Midscene ${reportFileName(src)}`} src={src} loading="lazy" />
          </section>
        ))}

      {hasVideos && (
        <section className="report-block">
          <div className="report-block-head">
            <h2>Відео тесту</h2>
          </div>
          <div className="report-videos">
            {reportPaths.videos!.map((src) => (
              <div key={src} className="report-video">
                <video controls preload="metadata" src={src} />
                <a href={src} target="_blank" rel="noreferrer">
                  {reportFileName(src)}
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasPlans && (
        <section className="report-block">
          <div className="report-block-head">
            <h2>AI-план</h2>
          </div>
          <ul className="report-links">
            {reportPaths.plans!.map((src) => (
              <li key={src}>
                <a href={src} target="_blank" rel="noreferrer">
                  {reportFileName(src)}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
