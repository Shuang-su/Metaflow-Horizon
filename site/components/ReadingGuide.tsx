import type { Article } from "../lib/types";
import { readingOverview, type ReadingLink } from "../lib/reading-navigation";

export default function ReadingGuide({ article, hasWeek = false, weekItems = [] }: { article: Article; hasWeek?: boolean; weekItems?: ReadingLink[] }) {
  const items = readingOverview(article, hasWeek, weekItems);
  const main = new Map(article.events?.filter(event => event.group === "main").map(event => [event.anchor, event]));
  return <nav className="reading-guide event-guide" aria-label="日报速览" id={article.readingGuide?.id || "reading-guide"}>
    <h2>日报速览</h2>
    <ol>{items.map((item, index) => {
      const event = main.get(item.id);
      return <li key={item.id}>
        <span className="guide-number" aria-hidden="true">{index + 1}</span>
        <div><a className="guide-title" href={`#${item.id}`}>{item.title}</a>
          {event?.judgment && <div className="guide-judgment" dangerouslySetInnerHTML={{ __html: event.judgment }} />}
          {!!event?.context.length && <div className="guide-context">{event.context.map((context, i) => <span key={i} dangerouslySetInnerHTML={{ __html: context.html }} />)}</div>}
          {!!item.children?.length && <details className="guide-subdirectory"><summary>展开{item.title}目录</summary><ul>{item.children.map(link => <li key={link.id}><a href={link.href || `#${link.id}`}>{link.title}</a></li>)}</ul></details>}
        </div>
      </li>;
    })}</ol>
  </nav>;
}
