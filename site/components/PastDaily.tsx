import Link from "./ArticleLink";
import type { Daily } from "../lib/types";
import { dailyUrl } from "../lib/catalog";
import { calendarDate } from "../lib/home";
import SourceImage from "./SourceImage";

export default function PastDaily({ reports }: { reports: Daily[] }) {
  if (!reports.length) return null;
  return <section className="past-daily" id="past-daily" aria-labelledby="past-daily-title">
    <div className="past-daily-inner">
      <header><h2 id="past-daily-title">往期日报</h2><Link href="/daily/">查看全部</Link></header>
      <div className="past-daily-list">
        {reports.map(report => {
          const { weekday, day } = calendarDate(report.date);
          return <article data-article-origin={`past:${report.id}`} className="past-daily-card" key={report.id}>
            <div>
              <time className="past-date" dateTime={report.date} aria-label={`${report.date} ${weekday}`}><span aria-hidden="true">{weekday}</span><strong aria-hidden="true">{day}</strong></time>
              <h3><Link href={dailyUrl(report.date)} prefetch={false}>{report.headline}</Link></h3>
            </div>
            {report.image && <SourceImage image={report.image} sizes="84px" />}
          </article>;
        })}
      </div>
    </div>
  </section>;
}
