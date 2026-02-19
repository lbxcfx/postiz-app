import styles from '@gitroom/frontend/components/content-factory/factory.page.module.scss';

type Props = {
  title: string;
  subtitle: string;
  badge: string;
  cards: {
    title: string;
    description: string;
  }[];
  showLogs?: boolean;
};

export const FactoryPage = ({ title, subtitle, badge, cards, showLogs }: Props) => {
  return (
    <div className={styles.factoryPage}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>{title}</div>
          <div className={styles.subtitle}>{subtitle}</div>
        </div>
        <div className={styles.badge}>{badge}</div>
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>Workflow 成功率</div>
              <div className={styles.kpiValue}>97.2%</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>发布成功率</div>
              <div className={styles.kpiValue}>94.1%</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>P95 阶段耗时</div>
              <div className={styles.kpiValue}>2m 31s</div>
            </div>
            <div className={styles.kpi}>
              <div className={styles.kpiLabel}>人工接管率</div>
              <div className={styles.kpiValue}>5.9%</div>
            </div>
          </div>
          <div className={styles.muted} style={{ marginTop: '10px' }}>
            指标字段与文档对齐：trace_id, workflow_id, stage, job_id, error_code, duration_ms
          </div>
        </div>

        {cards.map((card) => (
          <div key={card.title} className={styles.card}>
            <h3>{card.title}</h3>
            <p>{card.description}</p>
          </div>
        ))}

        {showLogs ? (
          <div className={styles.card}>
            <h3>链路日志</h3>
            <div className={styles.logs}>
              <div className={styles.logInfo}>[INFO] workflow=content_factory_xxx stage=COLLECTING</div>
              <div className={styles.logInfo}>[INFO] job_id=cf_xxx platform=xhs keywords=护肤</div>
              <div className={styles.logWarn}>[WARN] stage=PUBLISHING retry_count=1 error_code=XHS_TIMEOUT</div>
              <div className={styles.logError}>[ERROR] stage=PUBLISHING workflow_id=content_factory_xxx</div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
