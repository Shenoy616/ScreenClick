// 16 verticals · category filters · privacy-first role switcher

(function initSiteMeta() {
  const config = window.SCREENCLICK_SITE || {};
  const versionEl = document.querySelector('.footer-meta > span:first-child');
  if (versionEl && config.version && /^v[\d.]+$/.test(versionEl.textContent.trim())) {
    versionEl.textContent = `v${config.version}`;
  }
})();

const CATEGORIES = [
  { id: 'all', label: 'All teams' },
  { id: 'professional', label: 'Enterprise' },
  { id: 'product', label: 'Product & Dev' },
  { id: 'education', label: 'Education' },
  { id: 'agency', label: 'Agency' },
  { id: 'personal', label: 'Personal' },
];

const VERTICALS = [
  {
    id: 'healthcare',
    category: 'professional',
    label: 'Healthcare / MedTech',
    shortLabel: 'Healthcare',
    name: 'Healthcare & MedTech',
    privacyLead: true,
    tagline: 'On-device capture means no PHI ever touches the cloud',
    heroContext: 'The only safe screenshot tool for EHR workflows, clinical training, and patient portal support — PHI never leaves the machine.',
    heroLede: 'EHR walkthroughs, clinical trial documentation, and telehealth issue reproduction — captured and compiled entirely on-device. No network calls. No cloud storage. HIPAA-safe by architecture.',
    mockStep1: 'Step 3: Documented vitals entry',
    mockStep2: 'EHR workflow: patient lookup',
    mockUrl: 'ehr.internal.example.com/chart',
    mockFile: 'Clinical-SOP-Evidence.pdf',
    useCases: [
      'EHR and clinical platform workflow SOPs for staff training',
      'Clinical trial data entry step documentation',
      'Patient portal onboarding and troubleshooting guides',
      'FDA 21 CFR Part 11 software validation evidence',
      'Incident reporting workflow capture for risk management',
    ],
    modes: ['Process Record', 'Visible Tab', 'On-device only'],
    differentiator: 'No network calls, no analytics, no cloud storage. The only safe capture tool for workflows that touch patient data.',
  },
  {
    id: 'compliance',
    category: 'professional',
    label: 'Compliance officer',
    shortLabel: 'Compliance',
    name: 'Compliance & Audit',
    privacyLead: true,
    tagline: 'Tamper-proof, on-device workflow evidence for regulated processes',
    heroContext: 'SOX, HIPAA, and GDPR evidence packs — generated on your machine, never uploaded to a third party.',
    heroLede: 'Audit-ready PDF trails with timestamps and step labels. Capture consent screens, policy adherence, and access control states — all processed locally with zero cloud custody.',
    mockStep1: 'Clicked button: Accept & Continue',
    mockStep2: 'Step 3: Viewed disclosure screen',
    mockUrl: 'portal.example.com/consent',
    mockFile: 'SOX-Evidence-Pack-2026.pdf',
    useCases: [
      'SOX, HIPAA, GDPR workflow documentation with visual proof',
      'Capturing consent and disclosure screens at exact moment of acceptance',
      'Policy adherence documentation — prove an employee followed a defined process',
      'Timestamped evidence of access controls and permission states',
      'Third-party vendor access monitoring documentation',
    ],
    modes: ['Process Record', 'Timer', 'Visible Tab'],
    differentiator: 'On-device processing means sensitive compliance data never leaves the machine — no cloud upload, no third-party custody.',
  },
  {
    id: 'legal',
    category: 'professional',
    label: 'Legal team',
    shortLabel: 'Legal',
    name: 'Legal & eDiscovery',
    privacyLead: true,
    tagline: 'Preserve digital evidence on-device — no third-party custody',
    heroContext: 'Litigation-ready preservation with a clean chain of custody — because nothing ever hits a cloud server.',
    heroLede: 'Preserve web content before it disappears, document terms-of-service acceptance, and build chain-of-custody PDFs — all captured and compiled on your machine.',
    mockStep1: 'Captured: terms v3.2',
    mockStep2: 'Clicked: I Agree to Terms',
    mockUrl: 'vendor.example.com/terms-of-service',
    mockFile: 'Evidence-Preservation-2026-06-02.pdf',
    useCases: [
      'Preserve web content at a specific point in time',
      'Evidence of terms-of-service acceptance or disclosure acknowledgment',
      'Social media or portal state preservation for litigation',
      'Chain-of-custody PDF for court or regulatory submission',
      'Intellectual property infringement documentation',
    ],
    modes: ['Visible Tab', 'Entire Screen', 'Process Record'],
    differentiator: 'On-device processing maintains a clean chain of custody — essential for legal admissibility. No third-party servers.',
  },
  {
    id: 'finance',
    category: 'professional',
    label: 'Finance / Insurance',
    shortLabel: 'Finance',
    name: 'Finance & Insurance',
    privacyLead: true,
    tagline: 'Document transactions and claims with on-device evidence',
    heroContext: 'Claims, underwriting, and transaction trails — sensitive financial data stays on the machine.',
    heroLede: 'Step-by-step claims processing, underwriting decisions, and fraud investigation evidence — timestamped, labeled, and compiled on-device for regulators and auditors.',
    mockStep1: 'Step 6: Approved claim amount',
    mockStep2: 'Verified transaction: $12,450.00',
    mockUrl: 'claims.internal.example.com/review',
    mockFile: 'Claim-Review-Evidence.pdf',
    useCases: [
      'Claims processing step documentation — visual proof of handling',
      'Transaction verification trails for disputes or audits',
      'Underwriting workflow evidence — document the decision process',
      'Fraud investigation evidence — preserve suspicious screen states',
      'Internal control testing evidence for regulators',
    ],
    modes: ['Process Record', 'Visible Tab', 'Timer'],
    differentiator: 'Financial data stays on the machine — no cloud custody, no compliance review of a third-party vendor.',
  },
  {
    id: 'sales',
    category: 'professional',
    label: 'Sales / RevOps',
    shortLabel: 'Sales',
    name: 'Sales & Revenue Ops',
    tagline: 'From demo to leave-behind PDF, competitive intel to battlecard input',
    heroContext: 'Competitive intel and demo walkthroughs — captured locally, shared as PDF when you choose.',
    heroLede: 'Capture competitor pricing pages, demo narratives with auto-labeled steps, and win/loss evidence — as PDFs you attach to CRM records or send as leave-behinds.',
    mockStep1: 'Step 2: Viewed pricing tier: Enterprise',
    mockStep2: 'Captured competitor feature table',
    mockUrl: 'competitor.example.com/pricing',
    mockFile: 'Competitive-Intel-Q2.pdf',
    useCases: [
      'Competitor pricing pages and UI flows for battlecards',
      'Demo walkthroughs exported as annotated PDF leave-behinds',
      'CRM data entry evidence for audit trails or dispute resolution',
      'Win/loss evidence — competitor positioning at time of deal',
      'Sales process compliance documentation for regulated industries',
    ],
    modes: ['Visible Tab', 'Process Record', 'Entire Screen'],
    differentiator: 'Fast competitive intel capture — snap a full pricing page or record a demo narrative without switching tools.',
  },
  {
    id: 'qa',
    category: 'product',
    label: 'QA engineer',
    shortLabel: 'QA',
    name: 'QA & Testing',
    tagline: 'From test run to evidence PDF in one session',
    heroContext: 'Bug Reproduction packets and regression evidence — labeled, local, ready to attach to any ticket.',
    heroLede: 'Process Record auto-labels every step — export a UTC-stamped, signed PDF. Nothing uploaded between capture and ticket.',
    mockStep1: 'Clicked button: Submit Order',
    mockStep2: 'Typed in input: email',
    mockUrl: 'staging.example.com/checkout',
    mockFile: 'Regression-Run-2026-06-02.pdf',
    useCases: [
      'Regression evidence across releases — visual proof of what passed or failed',
      'Acceptance criteria documentation — exact state that satisfies a requirement',
      'End-to-end test documentation with Process Record auto-labeling',
      'Load test visual state capture using Timer mode',
      'Bug reproduction packets attached to tickets instead of step descriptions',
    ],
    modes: ['Process Record', 'Timer', 'Visible Tab'],
    differentiator: 'Process Record auto-labels each click and form fill — your test script writes itself as you walk the flow.',
  },
  {
    id: 'ux',
    category: 'product',
    label: 'UX researcher',
    shortLabel: 'UX',
    name: 'UX Research',
    tagline: 'Turn usability sessions into annotated evidence, not just notes',
    heroContext: 'Participant sessions stay on your machine — no cloud recording of sensitive research data.',
    heroLede: 'Capture exact states participants encounter, click-path evidence for design decisions, and competitive UX flows — as labeled PDFs stakeholders can actually read.',
    mockStep1: 'Step 5: Clicked nav: Pricing',
    mockStep2: 'Participant path captured at Step 8',
    mockUrl: 'competitor.example.com/pricing',
    mockFile: 'Usability-Session-07.pdf',
    useCases: [
      'Usability test session documentation with exact UI states',
      'Click-path evidence for design decisions and stakeholder reviews',
      'Before/after redesign comparisons with labeled steps',
      'Remote research session capture via Entire Screen mode',
      'Competitive UX analysis — document competitor flows for benchmarking',
    ],
    modes: ['Process Record', 'Timer', 'Entire Screen'],
    differentiator: 'Timer mode captures periodic snapshots as participants progress — no note-taker required.',
  },
  {
    id: 'devhandoff',
    category: 'product',
    label: 'Developer / PM',
    shortLabel: 'Dev handoff',
    name: 'Developer Handoff',
    tagline: 'Give engineers a reproducible spec, not just a screenshot',
    heroContext: 'Bug reports with exact Reproduction steps — captured locally, shared as PDF when ready.',
    heroLede: 'Annotated UI bug reports with Reproduction steps, design spec screenshots, and staging vs. production comparisons — labeled so engineers can reproduce exactly.',
    mockStep1: 'Step 2: Toggled feature flag OFF',
    mockStep2: 'Bug Reproduction: layout break',
    mockUrl: 'staging.example.com/dashboard',
    mockFile: 'Bug-Report-UI-4421.pdf',
    useCases: [
      'Annotated UI bug reports with exact reproduction steps',
      'Design spec screenshots for implementation reference',
      'Staging vs. production environment visual comparison',
      'Browser compatibility visual evidence across environments',
      'Feature flag state documentation before/after toggle',
    ],
    modes: ['Process Record', 'Visible Tab', 'Entire Screen'],
    differentiator: 'Process Record labels each step so engineers reproduce bugs on the first try — not after three Slack threads.',
  },
  {
    id: 'itops',
    category: 'product',
    label: 'IT / Ops lead',
    shortLabel: 'IT Ops',
    name: 'Change Management & IT Ops',
    tagline: 'Visual proof of every migration, rollout, and rollback',
    heroContext: 'Deployment evidence and rollback documentation — timestamped, on-device, audit-ready.',
    heroLede: 'Before/after migration screenshots, rollout verification, and configuration change documentation — timestamped state captured locally for stakeholder sign-off.',
    mockStep1: 'Pre-migration: system state captured',
    mockStep2: 'Post-deploy: verification passed',
    mockUrl: 'admin.internal.example.com/deploy',
    mockFile: 'Migration-Evidence-2026.pdf',
    useCases: [
      'Before/after system migration screenshots for stakeholder sign-off',
      'Rollout verification documentation — prove the deployment succeeded',
      'User acceptance testing evidence for enterprise software rollouts',
      'Configuration change documentation with timestamped state',
      'IT service desk issue reproduction and escalation',
    ],
    modes: ['Visible Tab', 'Entire Screen', 'Timer'],
    differentiator: 'Timer mode monitors deployment state over time — periodic captures without manual screenshot hunting.',
  },
  {
    id: 'edtech',
    category: 'education',
    label: 'L&D / Instructional designer',
    shortLabel: 'L&D',
    name: 'EdTech & Corporate Training',
    tagline: 'Walk through a process once — get a labeled guide automatically',
    heroContext: 'Training guides without video hosting — one walkthrough, one PDF, upload to your LMS.',
    heroLede: 'Step-by-step software tutorials, LMS-ready course content, and onboarding guides — auto-labeled clicks and form fills. No video editing, no upload time, no hosting costs.',
    mockStep1: 'Step 1: Clicked menu: Reports',
    mockStep2: 'Step 2: Filled filter: date range',
    mockUrl: 'internal.crm.example.com/reports',
    mockFile: 'New-Hire-CRM-Guide.pdf',
    useCases: [
      'Step-by-step software tutorial capture for course content',
      'LMS-ready course screenshot generation',
      'Platform walkthrough guides for new tool rollouts',
      'Franchisee or partner training documentation',
      'Compliance training evidence — prove the walkthrough occurred',
    ],
    modes: ['Process Record', 'Visible Tab', 'PDF export'],
    differentiator: 'No screen recorder means no video editing, no upload time, no hosting. One walkthrough = a PDF guide ready for any LMS.',
  },
  {
    id: 'research',
    category: 'education',
    label: 'Academic researcher',
    shortLabel: 'Research',
    name: 'Academic Research',
    tagline: 'Reproducible research documentation with zero overhead',
    heroContext: 'Methodology evidence and IRB workflows — captured locally, no research data in the cloud.',
    heroLede: 'Research tool workflow documentation for reproducibility, data collection step evidence for methodology sections, and IRB compliance workflow capture.',
    mockStep1: 'Step 4: Data entry confirmed',
    mockStep2: 'Platform state: submission complete',
    mockUrl: 'research.example.edu/portal',
    mockFile: 'Methodology-Evidence.pdf',
    useCases: [
      'Research tool and platform workflow documentation for reproducibility',
      'Data collection step evidence for methodology sections',
      'IRB compliance workflow capture for institutional review',
      'Lab software onboarding guides for new team members',
      'Grant portal submission workflow evidence',
    ],
    modes: ['Process Record', 'Visible Tab', 'Timer'],
    differentiator: 'Reproducible step documentation for papers and peer review — no cloud custody of sensitive research data.',
  },
  {
    id: 'knowledge',
    category: 'education',
    label: 'Technical writer',
    shortLabel: 'Docs',
    name: 'Knowledge Base & Documentation',
    tagline: 'Always-current screenshots, zero editing overhead',
    heroContext: 'Recapture in minutes when the UI changes — no screenshot hunting across 50 articles.',
    heroLede: 'Help center articles, internal wiki guides, and release notes with visual walkthroughs — one Process Record session produces an article-ready labeled sequence.',
    mockStep1: 'Step 1: Opened Settings panel',
    mockStep2: 'Step 2: Clicked Export data',
    mockUrl: 'help.example.com/account/export',
    mockFile: 'Help-Article-Screenshots.pdf',
    useCases: [
      'Help center article screenshot generation',
      'Internal wiki and Confluence how-to guides',
      'Release notes with visual walkthroughs of what changed',
      'Troubleshooting guide error state capture',
      'API and developer portal documentation screenshots',
    ],
    modes: ['Process Record', 'Visible Tab', 'Re-capture on UI change'],
    differentiator: 'When the UI changes, recapture in minutes — no editing needed, just re-run the flow.',
  },
  {
    id: 'agency',
    category: 'agency',
    label: 'Agency / Consultant',
    shortLabel: 'Agency',
    name: 'Agency & Freelance',
    tagline: 'Proof of work, client deliverables, and scope protection — in one PDF',
    heroContext: 'Client deliverables and scope documentation — professional PDFs, captured on your machine.',
    heroLede: 'Client deliverable proof, website audit documentation, scope creep evidence, and milestone sign-off — as professional PDFs ready to send.',
    mockStep1: 'Step 5: Completed audit checklist',
    mockStep2: 'Before/after: CRO optimization',
    mockUrl: 'client-site.example.com',
    mockFile: 'Client-Audit-Deliverable.pdf',
    useCases: [
      'Client deliverable proof of completion — visual evidence work was done',
      'Website review and audit documentation for clients',
      'Scope creep evidence — document what was agreed vs. requested',
      'Project milestone sign-off documentation',
      'Before/after optimization documentation (CRO, SEO, design)',
    ],
    modes: ['Process Record', 'Visible Tab', 'PDF export'],
    differentiator: 'One labeled walkthrough = a client-ready deliverable. No video editing, no cloud links that expire.',
  },
  {
    id: 'support',
    category: 'agency',
    label: 'Support lead',
    shortLabel: 'Support',
    name: 'Customer Support',
    tagline: 'Reproduce any issue and escalate with full context',
    heroContext: 'Escalation packets with labeled Reproduction steps — no "I can\'t reproduce it" ever again.',
    heroLede: 'Reproduce customer-reported bugs with labeled step-by-step evidence, capture error states for engineering hand-off, and build escalation packets with complete visual context.',
    mockStep1: 'Clicked link: Account Settings',
    mockStep2: 'Error state captured at Step 4',
    mockUrl: 'app.example.com/settings/billing',
    mockFile: 'Escalation-Ticket-8842.pdf',
    useCases: [
      'Reproduce customer-reported bugs with labeled step-by-step evidence',
      'Capture error states for engineering hand-off — eliminate "can\'t reproduce"',
      'Escalation packets with complete visual context for tier-2 and tier-3',
      'Onboarding issue documentation — where users get stuck',
      'Knowledge base content generation from live support sessions',
    ],
    modes: ['Process Record', 'Visible Tab', 'Entire Screen'],
    differentiator: 'Process Record labels each support step so engineering sees exactly what the agent did.',
  },
  {
    id: 'personal',
    category: 'personal',
    label: 'Power user',
    shortLabel: 'Personal',
    name: 'Personal Productivity',
    tagline: 'Capture anything you need to remember, prove, or share',
    heroContext: 'Personal archives and dispute evidence — private, on-device, no account required.',
    heroLede: 'Insurance claim state preservation, booking confirmations, billing dispute evidence, and important web content archiving — all on your machine, no cloud account needed.',
    mockStep1: 'Confirmation page captured',
    mockStep2: 'Archived: policy terms',
    mockUrl: 'insurance.example.com/claim/status',
    mockFile: 'Claim-Archive-2026.pdf',
    useCases: [
      'Insurance claim website state preservation before pages expire',
      'Online order and booking confirmation archiving',
      'Software issue reporting to vendors with reproducible steps',
      'Important web content archiving before it changes or disappears',
      'Personal audit trail for subscription or billing disputes',
    ],
    modes: ['Visible Tab', 'Process Record', 'Double-click'],
    differentiator: 'No account, no cloud, no subscription. Capture and save a PDF in under a minute.',
  },
  {
    id: 'realestate',
    category: 'personal',
    label: 'Real estate agent',
    shortLabel: 'Real estate',
    name: 'Real Estate & PropTech',
    tagline: 'Listing and transaction workflow evidence at every stage',
    heroContext: 'MLS snapshots and transaction documentation — captured before details change.',
    heroLede: 'MLS listing state preservation, transaction portal workflow documentation, and lease signing evidence — timestamped PDFs for compliance and client records.',
    mockStep1: 'Listing captured: price $425,000',
    mockStep2: 'Step 3: Submitted offer form',
    mockUrl: 'mls.example.com/listing/8842',
    mockFile: 'Listing-Evidence-2026.pdf',
    useCases: [
      'MLS listing state preservation — capture before prices or details change',
      'Transaction portal workflow documentation for compliance',
      'Inspection report platform walkthroughs for clients',
      'Lease and contract signing workflow evidence',
      'Mortgage portal submission workflow evidence',
    ],
    modes: ['Process Record', 'Visible Tab', 'Entire Screen'],
    differentiator: 'Process Record preserves every listing step — price, photos, and form submissions — before details change.',
  },
];

(function initRoleSwitcher() {
  const pillsEl = document.getElementById('role-pills');
  const gridEl = document.getElementById('vertical-grid');
  const categoryTabsEl = document.getElementById('category-tabs');
  if (!pillsEl) return;

  const LANDING_DEFAULT = { category: 'product', vertical: 'qa' };
  const LANDING_VERSION = '2';

  if (sessionStorage.getItem('sc-landing-v') !== LANDING_VERSION) {
    sessionStorage.removeItem('sc-vertical');
    sessionStorage.removeItem('sc-category');
    sessionStorage.setItem('sc-landing-v', LANDING_VERSION);
  }

  let activeCategory = sessionStorage.getItem('sc-category') || LANDING_DEFAULT.category;
  let activeId = sessionStorage.getItem('sc-vertical') || LANDING_DEFAULT.vertical;

  const selected = VERTICALS.find((v) => v.id === activeId);
  if (!selected) {
    activeId = LANDING_DEFAULT.vertical;
    activeCategory = LANDING_DEFAULT.category;
  } else if (activeCategory !== 'all' && selected.category !== activeCategory) {
    const inCategory = VERTICALS.find((v) => v.category === activeCategory);
    activeId = inCategory ? inCategory.id : LANDING_DEFAULT.vertical;
    activeCategory = VERTICALS.find((v) => v.id === activeId).category;
  }

  function filteredVerticals() {
    if (activeCategory === 'all') return VERTICALS;
    return VERTICALS.filter((v) => v.category === activeCategory);
  }

  function renderCategoryTabs() {
    if (!categoryTabsEl) return;
    categoryTabsEl.innerHTML = CATEGORIES.map(
      (c) =>
        `<button type="button" class="category-tab${c.id === activeCategory ? ' active' : ''}" data-category="${c.id}">${c.label}</button>`
    ).join('');
  }

  function renderPills() {
    const list = filteredVerticals();
    pillsEl.innerHTML = list.map(
      (v) =>
        `<button type="button" class="role-pill${v.id === activeId ? ' active' : ''}${v.privacyLead ? ' privacy-lead' : ''}" role="tab" aria-selected="${v.id === activeId}" data-id="${v.id}">${v.label}</button>`
    ).join('');
  }

  function renderGrid() {
    const list = filteredVerticals();
    gridEl.innerHTML = list.map(
      (v) => `
        <article class="vertical-card${v.id === activeId ? ' active' : ''}${v.privacyLead ? ' privacy-lead' : ''}" data-id="${v.id}" tabindex="0">
          ${v.privacyLead ? '<span class="vertical-privacy-badge">Privacy-critical</span>' : ''}
          <span class="vertical-card-tag">${v.shortLabel}</span>
          <h3>${v.name}</h3>
          <p class="vertical-card-tagline">${v.tagline}</p>
        </article>`
    ).join('');
  }

  function applyVertical(v, syncCategory = false) {
    activeId = v.id;
    sessionStorage.setItem('sc-vertical', v.id);

    if (syncCategory) {
      activeCategory = v.category;
      sessionStorage.setItem('sc-category', activeCategory);
      renderCategoryTabs();
      renderPills();
      renderGrid();
    }

    const ctx = document.getElementById('hero-context');
    const lede = document.getElementById('hero-lede');
    fadeText(ctx, v.heroContext);
    fadeText(lede, v.heroLede);
    document.getElementById('spotlight-tag').textContent = v.name;
    document.getElementById('spotlight-title').textContent = v.tagline;
    document.getElementById('spotlight-diff').textContent = v.differentiator;

    const listEl = document.getElementById('spotlight-list');
    listEl.innerHTML = v.useCases.map((u) => `<li>${u}</li>`).join('');

    const modesEl = document.getElementById('spotlight-modes');
    modesEl.innerHTML = v.modes.map((m) => `<span class="mode-chip">${m}</span>`).join('');

    const mock1 = document.getElementById('mock-step-1');
    const mock2 = document.getElementById('mock-step-2');
    if (mock1) mock1.querySelector('.pdf-step-action').textContent = v.mockStep1;
    if (mock2) mock2.querySelector('.pdf-step-action').textContent = v.mockStep2;
    document.getElementById('mock-url').textContent = v.mockUrl;
    document.getElementById('mock-filename').textContent = v.mockFile;

    if (!syncCategory) {
      pillsEl.querySelectorAll('.role-pill').forEach((btn) => {
        const on = btn.dataset.id === v.id;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on);
      });

      gridEl.querySelectorAll('.vertical-card').forEach((card) => {
        card.classList.toggle('active', card.dataset.id === v.id);
      });
    }

    const spotlight = document.getElementById('vertical-spotlight');
    spotlight.classList.remove('spotlight-flash');
    void spotlight.offsetWidth;
    spotlight.classList.add('spotlight-flash');

    if (syncCategory) {
      requestAnimationFrame(() => {
        const activePill = pillsEl.querySelector('.role-pill.active');
        if (activePill) {
          activePill.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        }
      });
    }
  }

  function setCategory(catId) {
    activeCategory = catId;
    sessionStorage.setItem('sc-category', activeCategory);
    renderCategoryTabs();
    renderPills();
    renderGrid();
    const visible = filteredVerticals();
    if (!visible.find((v) => v.id === activeId) && visible.length) {
      applyVertical(visible[0]);
    } else {
      applyVertical(VERTICALS.find((v) => v.id === activeId));
    }
  }

  renderCategoryTabs();
  renderPills();
  renderGrid();
  applyVertical(VERTICALS.find((v) => v.id === activeId), true);

  if (categoryTabsEl) {
    categoryTabsEl.addEventListener('click', (e) => {
      const tab = e.target.closest('.category-tab');
      if (!tab) return;
      setCategory(tab.dataset.category);
    });
  }

  pillsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-pill');
    if (!btn) return;
    const v = VERTICALS.find((x) => x.id === btn.dataset.id);
    if (v) applyVertical(v, true);
  });

  gridEl.addEventListener('click', (e) => {
    const card = e.target.closest('.vertical-card');
    if (!card) return;
    const v = VERTICALS.find((x) => x.id === card.dataset.id);
    if (v) {
      applyVertical(v, true);
      document.getElementById('vertical-spotlight').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  gridEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.vertical-card');
    if (!card) return;
    e.preventDefault();
    card.click();
  });
})();

function fadeText(el, text) {
  if (!el || el.textContent === text) return;
  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = text;
    el.style.opacity = '1';
  }, 120);
}

(function initMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const nav = document.getElementById('topbar-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open);
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });

  nav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open menu');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });
})();

(function initScrollReveals() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const targets = document.querySelectorAll(
    '.editorial-inner, .install-step, .feature, .vertical-card, .closing-title, .section-title, .vertical-spotlight, .compare-table-wrap, .section-sub, .privacy-card, .privacy-architecture'
  );

  targets.forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.7s cubic-bezier(0.2, 0.7, 0.2, 1), transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1)';
  });

  ['.feature', '.install-step', '.vertical-card', '.privacy-card'].forEach((sel) => {
    document.querySelectorAll(sel).forEach((el, i) => {
      el.dataset.staggerIndex = i;
    });
  });

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const stagger = parseInt(el.dataset.staggerIndex || '0', 10);
        el.style.transitionDelay = `${Math.min(stagger * 60, 480)}ms`;
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
        io.unobserve(el);
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
  );

  targets.forEach((el) => io.observe(el));
})();

(function initTopbarEnhancements() {
  const topbar = document.querySelector('.topbar');
  const navLinks = document.querySelectorAll('.topbar-nav a[href^="#"]');
  const sections = Array.from(navLinks)
    .map((link) => {
      const id = link.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      return el ? { link, el } : null;
    })
    .filter(Boolean);

  const setScrolled = () => {
    if (topbar) topbar.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  setScrolled();
  window.addEventListener('scroll', setScrolled, { passive: true });

  if (sections.length === 0) return;

  const setActive = (id) => {
    navLinks.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${id}`);
    });
  };

  const sectionObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible.length === 0) return;
      setActive(visible[0].target.id);
    },
    { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.25, 0.5] }
  );

  sections.forEach(({ el }) => sectionObserver.observe(el));
})();
