/** Сторінка 404 для невідомих маршрутів. */

import { Link, useLocation } from 'react-router-dom';
import { Empty } from '../components/states';
import { PageHead } from '../components/ui';
import { S } from '../strings';

export default function NotFoundPage() {
  const location = useLocation();
  return (
    <>
      <PageHead title={S.errors.routeTitle} />
      <div className="card">
        <Empty
          glyph="⌗"
          title={S.errors.routeTitle}
          hint={`${S.errors.routeHint} (${location.pathname})`}
          action={
            <Link className="btn btn-primary btn-sm" to="/">
              {S.errors.toDashboard}
            </Link>
          }
        />
      </div>
    </>
  );
}
