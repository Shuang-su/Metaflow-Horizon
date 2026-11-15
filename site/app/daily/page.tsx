import Link from "../../components/ArticleLink";
import SourceImage from "../../components/SourceImage";
import { dailyUrl, SITE_URL } from "../../lib/catalog";
import { loadArchive } from "../../lib/content";
import { calendarDate } from "../../lib/home";
import CollectionHeading from "./CollectionHeading";
import styles from "./collection.module.css";

export const metadata = { alternates: { canonical: `${SITE_URL}/daily/` }, title: "日报" };
export default async function Page() {
  const { index } = await loadArchive();
  return <section className={styles.collection} aria-labelledby="daily-collection-title">
    <div className="shell">
      <CollectionHeading count={index.daily.length} />
      <div className={styles.grid}>
        {index.daily.map(report => {
          const { weekday, day } = calendarDate(report.date);
          return <article key={report.id} data-article-origin={`archive:${report.id}`} className={styles.card}>
            <div className={styles.copy}>
              <time className={`past-date ${styles.date}`} dateTime={report.date} aria-label={`${report.date} ${weekday}`}>
                <span aria-hidden="true">{weekday}</span><strong aria-hidden="true">{day}</strong>
              </time>
              <h2><Link href={dailyUrl(report.date)} prefetch={false}>{report.headline}</Link></h2>
            </div>
            {report.image && <div className={styles.cover}><SourceImage image={report.image}
              sizes="(max-width: 767px) 34vw, (max-width: 1023px) 42vw, (max-width: 1440px) 29vw, 416px" /></div>}
            <p className={styles.meta}><span>高斯日报</span><span>Metaflow <time dateTime={report.date}>{report.date}</time></span></p>
          </article>;
        })}
      </div>
    </div>
  </section>;
}
