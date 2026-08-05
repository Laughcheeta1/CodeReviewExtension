const groupBy = (items, key) => {
  return items.reduce((groups, item) => {
    const group = key(item);
    (groups[group] ??= []).push(item);
    return groups;
  }, {});
};

const dashboardCards = [
  {
    id: "revenue",
    team: "commercial",
    title: "Revenue engine",
    description: "Recurring revenue and pipeline health.",
    metrics: [
      {
        id: "mrr",
        label: "MRR",
        value: 128400,
        trend: "up",
        tags: ["finance", "recurring"],
      },
      {
        id: "pipeline",
        label: "Pipeline",
        value: 742000,
        trend: "up",
        tags: ["sales", "forecast"],
      },
    ],
  },
  {
    id: "support",
    team: "operations",
    title: "Customer support",
    description: "Service quality across active accounts.",
    metrics: [
      {
        id: "tickets",
        label: "Open tickets",
        value: 42,
        trend: "down",
        tags: ["queue", "sla"],
      },
      {
        id: "satisfaction",
        label: "Satisfaction",
        value: 98.7,
        trend: "up",
        tags: ["csat", "quality"],
      },
    ],
  },
  {
    id: "growth",
    team: "commercial",
    title: "Growth experiments",
    description: "Experiments currently moving through the funnel.",
    metrics: [
      {
        id: "activation",
        label: "Activation",
        value: 64.2,
        trend: "up",
        tags: ["product", "onboarding"],
      },
      {
        id: "retention",
        label: "Retention",
        value: 87.3,
        trend: "down",
        tags: ["cohort", "lifecycle"],
      },
    ],
  },
];

const formatMetric = (metric) =>
  `${metric.label}: ${metric.value.toLocaleString()}`;

const groups = groupBy(dashboardCards, (card) => card.team);

export function Dashboard({ selectedTeam = "all", compact = false }) {
  const visibleCards = dashboardCards
    .filter(
      (card) => selectedTeam === "all" || card.team === selectedTeam,
    )
    .map((card) => ({
      ...card,
      metrics: card.metrics.filter(
        (metric) => !compact || metric.trend === "up",
      ),
    }));
  const visibleGroups = groupBy(visibleCards, (card) => card.team);

  return (
    <main className="dashboard" data-team={selectedTeam}>
      <header className="dashboard-header">
        <h1>Operations dashboard</h1>
        <p>{visibleCards.length} cards loaded</p>
      </header>

      <section className="cards" aria-label="Dashboard cards">
        {visibleCards.length === 0 ? (
          <p className="empty">No cards match this filter.</p>
        ) : (
          visibleCards.map((card) => (
            <article className="card" key={card.id}>
              <header>
                <h2>{card.title}</h2>
                <p>{card.description}</p>
              </header>
              <div className="metric-grid">
                {card.metrics.map((metric) => (
                  <div className="metric" key={metric.id}>
                    <span className="metric-label">{metric.label}</span>
                    <strong>{formatMetric(metric)}</strong>
                    <span className={`trend ${metric.trend}`}>
                      {metric.trend === "up" ? "Growing" : "Watch"}
                    </span>
                    <ul>
                      {metric.tags.map((tag) => (
                        <li key={tag}>{tag}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </article>
          ))
        )}
      </section>

      <aside className="teams">
        <h2>Teams</h2>
        {Object.entries(visibleGroups).map(([team, teamCards]) => (
          <section className="team" key={team}>
            <h3>{team}</h3>
            {teamCards.map((card) => (
              <>
                <span data-card={card.id}>{card.title}</span>
                {card.metrics
                  .filter((metric) => metric.trend === "up")
                  .map((metric) => (
                    <em key={`${card.id}-${metric.id}`}>
                      {metric.label}: {metric.value}
                    </em>
                  ))}
              </>
            ))}
          </section>
        ))}
      </aside>
    </main>
  );
}
