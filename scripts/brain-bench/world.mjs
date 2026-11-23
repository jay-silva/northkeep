// The fictional world the bench scores against. Every person, company, place
// and number here is invented. Text dates assume the bench "today" is late
// November 2026; each memory's saved date is "days ago" from the seed time.

export const PERSONA = 'Morgan Vale';

const USER = 'cli';
const CLAUDE = 'mcp:claude-code';
const CURSOR = 'mcp:cursor';
const GROK = 'connector:grok-bot';
const IMPORT = 'import:chatgpt';

/** One memory: saved `days` ago by `source`. `confirmed` marks a fact the user confirmed. */
const m = (days, source, type, scope, text, extra = {}) => ({ days, source, type, scope, text, ...extra });
const confirmed = (days, type, scope, text) => m(days, USER, type, scope, text, { confirmed: true });
/** An AI app's session note: episodic, in the conversations scope. */
const note = (days, source, text) => m(days, source, 'episodic', 'conversations', text);

const CABIN = 'project:heron-cabin';

export const MEMORIES = [
  // The core record the user confirmed.
  confirmed(14, 'identity', 'work', 'Morgan Vale is the Operations Manager at Tidewater Ferry Authority.'),
  confirmed(14, 'identity', 'work', 'Morgan teaches the Saturday deckhand course at Marlow Maritime School.'),
  confirmed(14, 'semantic', 'personal', 'Larkspur Holdings LLC is Morgan\'s holding company. It owns Larkspur Cabins LLC and Larkspur Works LLC.'),
  confirmed(14, 'semantic', 'personal', 'Larkspur Cabins LLC owns Heron Cabin, a short-term rental in Pine Hollow, Vermont, listed through Staylark.'),
  confirmed(14, 'semantic', 'personal', 'Larkspur Works LLC is Morgan\'s software company.'),
  confirmed(14, 'semantic', 'personal', 'Quarry Road Partners LLC is owned 50/50 by Morgan and Dana Okafor.'),
  confirmed(13, 'identity', 'personal', 'Morgan\'s spouse is Riley Vale.'),
  confirmed(13, 'identity', 'personal', 'Morgan\'s children are Juno, born March 9, 2012, and Felix, born November 21, 2015.'),
  confirmed(13, 'procedural', 'personal', 'Sign formal documents "Morgan A. Vale" and casual notes "Mo".'),
  confirmed(13, 'procedural', 'personal', 'Never use em dashes in anything public.'),
  confirmed(13, 'identity', 'personal', 'Morgan is allergic to shellfish.'),
  confirmed(12, 'semantic', 'work', 'Ines Calder is the Harbor Master at Tidewater Ferry Authority and Morgan\'s boss.'),
  confirmed(12, 'semantic', 'work', 'Dana Reyes is the Finance Director at Tidewater Ferry Authority. Dana Reyes is not Dana Okafor.'),
  confirmed(12, 'semantic', 'personal', 'Which entity holds Morgan\'s half of Quarry Road Partners is disputed: the operating agreement says Larkspur Holdings LLC, the Granite Savings loan papers say Larkspur Cabins LLC. Ask Morgan which entity to name on any legal, tax or bank document.'),
  confirmed(12, 'procedural', 'personal', 'Reports for Morgan run 400 words at most, answer first.'),
  confirmed(11, 'identity', 'personal', 'Morgan\'s mother is Anne Vale. She lives in Camden.'),
  confirmed(11, 'semantic', 'personal', 'Whether the Heron Cabin hot tub is covered by the Alder Mutual policy is unresolved: the agent said yes by phone, the policy wording excludes it. Ask Morgan before telling anyone it is covered.'),
  confirmed(11, 'identity', 'personal', 'Morgan lives in Eastbrook.'),

  // Family and personal facts AI apps saved.
  m(200, CLAUDE, 'semantic', 'personal', 'Morgan\'s dog Biscuit is a corgi born in 2021.'),
  m(190, CURSOR, 'semantic', 'personal', 'Morgan has a corgi called Biscuit.'),
  m(230, GROK, 'semantic', 'personal', 'Pepper is Morgan\'s second corgi, adopted in March 2026.'),
  m(400, IMPORT, 'semantic', 'personal', 'Morgan drives a 2015 Honda CR-V.'),
  m(150, CLAUDE, 'semantic', 'personal', 'Morgan traded the CR-V for a 2019 Subaru Outback in June 2026.'),
  m(420, IMPORT, 'semantic', 'personal', 'Morgan\'s accountant is Leo Marsh at Marsh Tax.'),
  m(95, GROK, 'semantic', 'personal', 'Morgan moved the books to Priya Shah at Shah & Lowe in August 2026. Leo Marsh no longer does them.'),
  m(180, CURSOR, 'semantic', 'personal', 'Morgan\'s attorney is Tom Brandt at Brandt Law. He handles the LLC filings.'),
  m(210, GROK, 'semantic', 'personal', 'Morgan\'s physician is Dr. Lena Ortiz at Eastbrook Family Practice.'),
  m(170, CLAUDE, 'semantic', 'personal', 'Riley Vale is a pediatric nurse at Eastbrook General.'),
  m(160, GROK, 'semantic', 'personal', 'Riley is a nurse.'),
  m(80, GROK, 'semantic', 'personal', 'Juno plays cello.'),
  m(75, GROK, 'semantic', 'personal', 'Juno\'s cello lesson moved to Tuesdays at 4:30 from September 2026.'),
  m(85, GROK, 'semantic', 'personal', 'Felix\'s soccer team is the Eastbrook Otters.'),
  m(50, GROK, 'semantic', 'personal', 'Otters practice moved to Thursdays at 5:30 this season.'),
  m(300, IMPORT, 'semantic', 'personal', 'Riley and Morgan\'s anniversary is June 14.'),
  m(290, IMPORT, 'semantic', 'personal', 'Anne Vale\'s birthday is February 2.'),
  m(60, CLAUDE, 'procedural', 'personal', 'Morgan prefers an aisle seat on flights.'),
  m(45, GROK, 'procedural', 'personal', 'Morgan drinks an oat flat white.'),
  m(70, CLAUDE, 'procedural', 'personal', 'Morgan likes meeting notes as bullet points with an owner and a date on each.'),
  m(28, GROK, 'semantic', 'personal', 'Morgan switched gyms to Harbor Athletic Club in October 2026.'),
  m(500, IMPORT, 'semantic', 'personal', 'Felix attends Birchwood Elementary.'),
  m(70, GROK, 'semantic', 'personal', 'Felix started at Eastbrook Middle School in September 2026.'),
  m(55, CLAUDE, 'procedural', 'personal', 'Do not schedule calls before noon on Saturdays; Morgan is teaching.'),

  // Work.
  m(100, CLAUDE, 'semantic', 'work', 'The MV Kestrel is Tidewater\'s spare boat.'),
  m(100, CLAUDE, 'semantic', 'work', 'The MV Osprey runs the main route in the mornings.'),
  m(99, CLAUDE, 'semantic', 'work', 'The MV Tern runs the main route in the afternoons.'),
  m(90, CURSOR, 'semantic', 'work', 'The Coast Guard annual inspection for the MV Osprey is due February 12, 2027.'),
  m(60, GROK, 'semantic', 'work', 'Sam Whitlock replaced Carla Mendez as deputy operations manager in September 2026.'),
  m(120, CLAUDE, 'semantic', 'work', 'Bea Lindqvist is the union steward for the deck crews.'),
  m(200, CLAUDE, 'semantic', 'work', 'Morgan\'s 100-ton master license expires May 1, 2027.'),
  m(199, CLAUDE, 'semantic', 'work', 'Morgan\'s TWIC card expires August 30, 2028.'),
  m(25, CLAUDE, 'semantic', 'work', 'The MV Tern returned to service on November 3, 2026 after its engine overhaul.'),
  m(40, CLAUDE, 'semantic', 'work', 'Dana Reyes signs off on the Tidewater operating budget each March.'),
  m(26, GROK, 'semantic', 'work', 'The weekly ops meeting moved to Tuesdays at 7:30 in October 2026.'),
  m(33, CURSOR, 'semantic', 'work', 'Parking at the terminal moved to spot A4 after the lot was repaved.'),
  // Two records from the same day that disagree; nothing marks either as right.
  m(19, CLAUDE, 'semantic', 'work', 'Holiday on-call roster: Morgan covers Christmas Day.'),
  m(19, GROK, 'semantic', 'work', 'Holiday on-call roster: Sam Whitlock covers Christmas Day and Morgan covers New Year\'s Day.'),

  // The cabin.
  m(220, CLAUDE, 'semantic', CABIN, 'Heron Cabin sleeps eight in three bedrooms.'),
  m(215, CLAUDE, 'semantic', CABIN, 'Marisol Peña cleans Heron Cabin on changeover days.'),
  m(35, GROK, 'semantic', CABIN, 'Marisol\'s changeover fee went to $165 in October 2026.'),
  m(40, CLAUDE, 'semantic', CABIN, 'Heron Cabin\'s minimum stay is two nights, three on holiday weekends, since September 2026.'),
  m(380, IMPORT, 'semantic', 'personal', 'Heron Cabin internet is Pinecone Wireless.'),
  m(190, CLAUDE, 'semantic', CABIN, 'Heron Cabin switched to Greenline Fiber in May 2026.'),
  m(205, CURSOR, 'semantic', CABIN, 'Hale Plumbing handles plumbing at Heron Cabin.'),
  m(204, CURSOR, 'semantic', CABIN, 'Dunmore Plowing plows the Heron Cabin driveway.'),
  m(360, IMPORT, 'semantic', 'personal', 'The Heron Cabin hot tub is serviced by ClearSpa.'),
  m(65, GROK, 'semantic', CABIN, 'Hot tub service moved to Summit Pools after ClearSpa closed.'),
  m(250, CLAUDE, 'semantic', 'personal', 'Heron Cabin is insured with Alder Mutual. The policy renews January 15.'),
  m(249, CLAUDE, 'semantic', 'personal', 'Morgan\'s umbrella policy is with Keystone.'),
  m(350, IMPORT, 'semantic', 'personal', 'The cabin\'s operating account is at Granite Savings.'),
  m(90, CLAUDE, 'semantic', 'personal', 'Morgan moved the Heron Cabin operating account to Northfield Credit Union in 2026.'),
  m(30, GROK, 'semantic', CABIN, 'Staylark\'s host fee rose to 15% on October 1, 2026.'),
  m(48, CLAUDE, 'semantic', CABIN, 'Heron Cabin\'s base rate is $285 a night as of September 2026.'),

  // The rentals.
  m(320, IMPORT, 'semantic', 'personal', 'Quarry Road Partners owns 12 Quarry Road, a single-family rental bought in 2019.'),
  m(318, IMPORT, 'semantic', 'personal', 'Quarry Road Partners owns the duplex at 8 Alder Lane, bought in 2022.'),
  m(260, CLAUDE, 'semantic', 'personal', '12 Quarry Road is rented to the Abara family through June 2027.'),
  m(400, IMPORT, 'semantic', 'personal', 'Rent at 12 Quarry Road is $2,300 a month.'),
  m(160, CLAUDE, 'semantic', 'personal', 'Rent at 12 Quarry Road went to $2,450 a month on the June 2026 renewal.'),
  m(390, IMPORT, 'semantic', 'personal', '8 Alder Lane upstairs is rented to the Vasquez family.'),
  m(130, CLAUDE, 'semantic', 'personal', 'Colm Reddy took over the upstairs lease at 8 Alder Lane in July 2026.'),
  m(30, GROK, 'semantic', 'personal', 'Nell Park moved out of 8 Alder Lane downstairs on October 15, 2026. The unit is vacant.'),
  m(240, CLAUDE, 'semantic', 'personal', 'Quarry Road Partners banks with Granite Savings.'),
  m(175, CLAUDE, 'semantic', 'personal', 'Dana Okafor takes the tenant calls for the Quarry Road rentals.'),
  m(172, CURSOR, 'semantic', 'personal', 'Eastbrook Heating & Oil services the boilers at both rentals and has a 24-hour line.'),
  m(22, CURSOR, 'semantic', 'personal', 'The security deposit for 8 Alder Lane upstairs is $1,700.'),
  m(22, GROK, 'semantic', 'personal', '8 Alder Lane upstairs security deposit: $2,000, held at Granite Savings.'),
  m(62, CLAUDE, 'semantic', 'project:quarry-road-refi', 'The Quarry Road refinance closed at 6.75% fixed for five years on $380,000.'),

  // Old session notes from AI apps. Each carries one claim that later changed.
  note(140, CLAUDE, 'Session note: planned the summer calendar with Morgan. Juno\'s cello lesson is Wednesdays at 5, so family dinners move to Thursday. Riley is on nights the second week of July. Booked nothing; Morgan will confirm the camp dates with Riley first.'),
  note(110, GROK, 'Session note: went through the fall sports sign-up. Felix\'s soccer practice is Mondays, and games are Saturday mornings, which clashes with the deckhand course. Morgan will ask Riley to cover the Saturday games.'),
  note(130, CLAUDE, 'Session note: drafted the staffing memo for the ferry. Deputy operations manager is Carla Mendez, who will run the morning briefings while Morgan is at the Coast Guard meeting. The memo goes to Ines Calder for sign-off.'),
  note(120, CLAUDE, 'Session note: reviewed the fleet status. The MV Tern is out for an engine overhaul until further notice, so the Kestrel covers afternoons. Morgan asked for a one-page summary for the board with the overhaul cost left blank.'),
  note(115, CURSOR, 'Session note: set up the terminal access list. Morgan\'s parking spot at the terminal is B12. The gate fob list needs the two new deckhands added once HR sends their start dates.'),
  note(150, CLAUDE, 'Session note: worked through the Heron Cabin budget. Marisol charges $140 per changeover, about four changeovers a month in season. Firewood and propane are the next largest costs. Morgan wants the numbers again after the fall bookings come in.'),
  note(140, GROK, 'Session note: rewrote the Heron Cabin listing rules. The minimum stay at Heron Cabin is three nights, with a cleaning fee on top. Morgan asked whether shorter stays would fill the midweek gaps and wants to look at it in the fall.'),
  note(125, CLAUDE, 'Session note: compared booking sites for Heron Cabin. Staylark takes 12% from the host, which is lower than the two alternatives Morgan looked at. No change planned.'),
  note(100, GROK, 'Session note: tenant roundup for the rentals. 8 Alder Lane downstairs is rented to Nell Park, who asked about getting a cat. Dana Okafor will answer her. The upstairs lease is fine.'),
  note(120, CLAUDE, 'Session note: read the lender\'s paperwork with Morgan. The commitment letter for the Quarry Road refinance says 7.10% fixed, and Morgan plans to ask Granite Savings for a better rate before signing.'),
  note(105, CURSOR, 'Session note: the ferry crew app is on TestFlight build 9. Two captains could not log in; fixed the Supabase redirect and queued a new build.'),

  // Long conversation summaries: many words, no answers.
  note(90, CLAUDE, 'Conversation summary. Morgan asked for help thinking through a busy month: the ferry schedule change, a staffing gap on the deck crews, the cabin bookings, two tenant requests at the rentals, the dogs needing a kennel for a weekend away, the kids\' school forms, a birthday dinner for Riley\'s sister, the car service, the accountant\'s year-end list, the lawyer\'s reminder about annual LLC reports, the doctor\'s office calling about a check-up, insurance renewals, the union meeting, the Coast Guard paperwork, a broken dock light, the cabin\'s gutters, a plumber visit, snow plowing quotes, internet at the cabin, and the software side project. We sorted them into this week, this month and later, and Morgan picked three to do first. No facts were settled in this conversation; it was planning only, and every item still needs its own follow-up.'),
  note(75, GROK, 'Conversation summary. A long talk about whether to buy a third rental. Morgan and Dana went back and forth on price, rent, the bank, the rate, repairs, tenants, taxes, insurance, the holding company, the partnership, the operating agreement, the lender, the appraisal, the inspection, the roof, the boiler, the neighborhood, schools, parking, and whether the cabin\'s income could help with the down payment. Nothing was decided. Morgan wants to revisit it in the spring after the winter season at the cabin and the ferry\'s budget are both known.'),
  note(45, CLAUDE, 'Conversation summary. Morgan talked through the ferry\'s winter plans: boats, crews, the schedule, the spare vessel, inspections, the union roster, holiday coverage, the harbor master\'s priorities, the finance director\'s budget questions, the deputy\'s training, parking at the terminal, the weekly meeting, licenses coming due, and the deckhand course on Saturdays. It was a status rundown with no decisions; the details live in the individual notes and the winter schedule project.'),

  // Recent session notes that are right.
  note(9, CLAUDE, 'Session note: Morgan confirmed the core record today from the command line. No other changes.'),
  note(6, GROK, 'Session note: helped Morgan word a reply to a Heron Cabin guest about early check-in. No facts changed.'),

  // Things nobody asks about, to give search something to wade through.
  m(88, CURSOR, 'procedural', 'project:ferry-crew-app', 'Use pnpm in the crew app repository; npm breaks the lockfile.'),
  m(87, CURSOR, 'procedural', 'project:ferry-crew-app', 'Run the crew app tests against a throwaway database, never the live one.'),
  m(86, CURSOR, 'semantic', 'project:ferry-crew-app', 'The crew app uses email magic links for sign-in.'),
  m(66, CLAUDE, 'semantic', 'work', 'The terminal ticket office opens at 5:30 on weekdays.'),
  m(64, CLAUDE, 'semantic', 'work', 'Fuel deliveries to the dock are on Wednesdays.'),
  m(58, GROK, 'semantic', 'personal', 'Morgan is repainting the porch at home in the spring.'),
  m(57, GROK, 'semantic', 'personal', 'Riley\'s sister Tess lives in Portland.'),
  m(52, CLAUDE, 'procedural', 'personal', 'Morgan prefers morning flights when traveling for work.'),
  m(51, CLAUDE, 'semantic', CABIN, 'Heron Cabin firewood is delivered by the cord in October.'),
  m(49, CLAUDE, 'semantic', CABIN, 'Heron Cabin check-in is 4pm and check-out is 10am.'),
  m(47, GROK, 'semantic', 'personal', 'The Outback is due for service every 6,000 miles.'),
  m(44, CURSOR, 'semantic', 'project:corgi-dash', 'Corgi Dash is written in Godot.'),
  m(43, CLAUDE, 'semantic', 'work', 'Deckhand course enrollment is capped at twelve students.'),
  m(42, CLAUDE, 'semantic', 'personal', 'Morgan keeps LLC records in a shared drive folder called Larkspur Records.'),
  m(38, GROK, 'semantic', 'personal', 'Juno is in the school orchestra.'),
  m(37, GROK, 'semantic', 'personal', 'Felix wants to try out for goalkeeper.'),
  m(36, CLAUDE, 'semantic', 'work', 'The winter schedule cuts the last evening sailing on weekdays.'),
  m(34, CLAUDE, 'semantic', 'personal', 'Morgan\'s home office is in the back bedroom.'),
  // Project chatter whose words collide with a personal question about dogs.
  ...Array.from({ length: 10 }, (_, i) => m(12 + i * 6, CURSOR, 'episodic', 'project:corgi-dash', `Corgi Dash build ${i + 1} shipped with new corgi dog art and a faster run loop.`)),
];

/** Project documents, created through the same path the app uses. */
export const PROJECTS = [
  { slug: 'heron-cabin', days: 240, title: 'Heron Cabin', what_why: 'Day-to-day running of Heron Cabin, the short-term rental in Pine Hollow.', status: 'Heron Cabin is booked most weekends through December. Changeovers and vendors are running normally.', next_actions: '- Confirm the insurance renewal.\n- Book the chimney sweep.' },
  { slug: 'heron-winter-campaign', days: 50, title: 'Heron Cabin winter campaign', what_why: 'Fill the open winter weeks at Heron Cabin.', status: 'The winter campaign has the listing photos half done. Holiday weeks are booked; January is open.', next_actions: '- Photograph the new wood stove for the listing.\n- Draft the past-guest email after that.' },
  { slug: 'quarry-road-refi', days: 150, title: 'Quarry Road refinance', what_why: 'Refinance the Quarry Road Partners loan with Granite Savings.', status: 'The Quarry Road refinance closed on September 18, 2026. Nothing is open except filing the final documents.', next_actions: '- File the closing documents in Larkspur Records.' },
  { slug: 'ferry-crew-app', days: 200, title: 'Ferry crew app', what_why: 'A crew scheduling app for Tidewater deck crews, built with React Native and Supabase by Larkspur Works.', status: 'TestFlight build 14 is with five captains. Waiting on their feedback before build 15.', next_actions: '- Collect feedback from the five captains.' },
  { slug: 'corgi-dash', days: 120, title: 'Corgi Dash', what_why: 'A small endless-runner game about corgis, a Larkspur Works side project.', status: 'Corgi Dash is on milestone 2, the leaderboard. Milestone 1, the core run loop, passed in October.', next_actions: '- Build the leaderboard screen.' },
  { slug: 'winter-schedule', days: 60, title: 'Tidewater winter schedule', what_why: 'Publish the Tidewater winter ferry schedule.', status: 'The winter schedule draft is done. It is waiting on the union\'s sign-off on the holiday roster.', next_actions: '- Meet Bea Lindqvist about the holiday roster.' },
];

/** What the chat app itself remembers about the user. Some of it is out of date. */
export const APP_NOTES = [
  'The user\'s name is Morgan Vale.',
  'Works at Tidewater Ferry Authority.',
  'Gym: IronWorks on Dock Street.',
  'Riley works at St. Brendan\'s Clinic.',
  'Heron Cabin nightly base rate: $240.',
  'Felix plays for the Eastbrook Comets.',
  'Weekly ops meeting: Mondays at 8.',
  'Coffee order: black americano.',
  'Favorite band: The Low Tides.',
  'Training for the Eastbrook 10K in May.',
  'Laptop: 14-inch MacBook Pro.',
  'Reads mostly maritime history.',
  'Has two kids.',
  'Likes concise answers.',
];

/**
 * A question. `must` is a list of groups; an answer needs one phrase from
 * every group. `must_not` phrases are the out-of-date value. `expect` is
 * "answer" (default), "abstain" (the fact is nowhere), or "flag" (the record
 * says the fact is disputed, or two records disagree); a flag answer either
 * says so or names every value in `both`.
 */
const q = (id, cat, text, must, extra = {}) => ({ id, cat, q: text, must, expect: 'answer', must_not: [], ...extra });
const absent = (id, text, extra = {}) => ({ id, cat: 'absent', q: text, must: [], must_not: [], expect: 'abstain', ...extra });
const flag = (id, cat, text, both) => ({ id, cat, q: text, must: [], must_not: [], expect: 'flag', both });

export const QUESTIONS = [
  // core: the user confirmed these.
  q('core-01', 'core', 'Where do I work, and what\'s my title?', [['tidewater'], ['operations manager']]),
  q('core-02', 'core', 'What\'s the name of my holding company?', [['larkspur holdings']]),
  q('core-03', 'core', 'Which of my companies owns the cabin?', [['larkspur cabins']]),
  q('core-04', 'core', 'Who is my partner in Quarry Road Partners?', [['okafor']]),
  q('core-05', 'core', 'What\'s my spouse\'s name?', [['riley']]),
  q('core-06', 'core', 'When is Juno\'s birthday?', [['march 9', 'march 9th', '3/9', '2012-03-09', '9 march', '9th of march']]),
  q('core-07', 'core', 'How do I sign a formal letter?', [['morgan a vale']]),
  q('core-08', 'core', 'Do I have any food allergies?', [['shellfish']]),
  q('core-09', 'core', 'Who is my boss?', [['calder']]),
  q('core-10', 'core', 'What punctuation rule do I have for anything public?', [['em dash', 'em dashes']]),
  q('core-11', 'core', 'What state is Heron Cabin in?', [['vermont']]),
  q('core-12', 'core', 'Where does my mother live?', [['camden']]),
  q('core-13', 'core', 'What does Larkspur Works do?', [['software']]),
  q('core-14', 'core', 'How long should a report for me be?', [['400']]),

  // direct: one clean fact, saved by an AI app, in the words of the question.
  q('direct-01', 'direct', 'When does my 100-ton master license expire?', [['may 1', 'may 1st', '2027-05-01', '5/1', '1 may', 'may 2027'], ['2027']]),
  q('direct-02', 'direct', 'Who cleans Heron Cabin?', [['marisol', 'pena']]),
  q('direct-03', 'direct', 'How many people does Heron Cabin sleep?', [['eight', '8']]),
  q('direct-04', 'direct', 'Who rents 12 Quarry Road?', [['abara']]),
  q('direct-05', 'direct', 'Which boat is the spare at Tidewater?', [['kestrel']]),
  q('direct-06', 'direct', 'When is the Coast Guard inspection for the Osprey due?', [['february 12', 'feb 12', '2/12', '2027-02-12', '12 february', 'february 12th']]),
  q('direct-07', 'direct', 'Who is the union steward for the deck crews?', [['lindqvist']]),
  q('direct-08', 'direct', 'What seat do I prefer on flights?', [['aisle']]),
  q('direct-09', 'direct', 'Who insures Heron Cabin?', [['alder mutual']]),
  q('direct-10', 'direct', 'When does the Heron Cabin insurance policy renew?', [['january 15', 'jan 15', '1/15', '15 january', 'january 15th']]),
  q('direct-11', 'direct', 'When is my anniversary?', [['june 14', 'jun 14', '6/14', '14 june', 'june 14th']]),
  q('direct-12', 'direct', 'What instrument does Juno play?', [['cello']]),
  q('direct-13', 'direct', 'When does my TWIC card expire?', [['2028']]),
  q('direct-14', 'direct', 'Where does Quarry Road Partners bank?', [['granite savings']]),
  q('direct-15', 'direct', 'When is Anne Vale\'s birthday?', [['february 2', 'feb 2', '2/2', '2 february', 'february 2nd']]),
  q('direct-16', 'direct', 'How do I like meeting notes written?', [['bullet']]),

  // paraphrase: the record uses different words from the question.
  q('para-01', 'paraphrase', 'Who\'s my lawyer?', [['brandt']]),
  q('para-02', 'paraphrase', 'Who\'s my doctor?', [['ortiz']]),
  q('para-03', 'paraphrase', 'What breed are my pets?', [['corgi', 'corgis']]),
  q('para-04', 'paraphrase', 'Who fixes the pipes at the cabin?', [['hale']]),
  q('para-05', 'paraphrase', 'What do I teach on weekends?', [['deckhand']]),
  q('para-06', 'paraphrase', 'What does my spouse do for a living?', [['nurse']]),
  q('para-07', 'paraphrase', 'Who do I call when a tenant\'s heat goes out?', [['eastbrook heating']]),
  q('para-08', 'paraphrase', 'What captain\'s credential do I hold?', [['100-ton', '100 ton', 'master license', 'master licence']]),
  q('para-09', 'paraphrase', 'Which booking site is the cabin on?', [['staylark']]),
  q('para-10', 'paraphrase', 'Who handles snow removal at the cabin?', [['dunmore']]),

  // stale: an old AI session note says one thing, a newer fact says another.
  q('stale-01', 'stale', 'What interest rate did the Quarry Road refinance close at?', [['6.75']], { must_not: ['7.10', '7.1'] }),
  q('stale-02', 'stale', 'Who is my deputy at the ferry?', [['whitlock']]),
  q('stale-03', 'stale', 'What\'s the minimum stay at Heron Cabin on an ordinary weekend?', [['two night', '2 night', 'two-night', '2-night', 'two nights', '2 nights']]),
  q('stale-04', 'stale', 'Who rents the downstairs unit at 8 Alder Lane?', [['vacant', 'empty', 'no one', 'nobody', 'unoccupied', 'moved out', 'no tenant']]),
  q('stale-05', 'stale', 'What day is Juno\'s cello lesson?', [['tuesday', 'tuesdays']]),
  q('stale-06', 'stale', 'What does the Heron Cabin cleaner charge per changeover?', [['165']]),
  q('stale-07', 'stale', 'Is the MV Tern in service right now?', [['returned', 'back in service', 'is in service', 'yes']], { must_not: ['out of service', 'not in service', 'still out', 'until further notice'] }),
  q('stale-08', 'stale', 'What day is Felix\'s soccer practice?', [['thursday', 'thursdays']]),
  q('stale-09', 'stale', 'What percentage does Staylark take from me as host?', [['15']]),
  q('stale-10', 'stale', 'Where do I park at the terminal?', [['a4']]),

  // changed: two facts from AI apps, the newer one is right.
  q('changed-01', 'changed', 'What car do I drive?', [['outback', 'subaru']]),
  q('changed-02', 'changed', 'Who is my accountant?', [['priya', 'shah']]),
  q('changed-03', 'changed', 'Who is the internet provider at Heron Cabin?', [['greenline']]),
  q('changed-04', 'changed', 'Who rents the upstairs unit at 8 Alder Lane?', [['reddy']]),
  q('changed-05', 'changed', 'What\'s the monthly rent at 12 Quarry Road?', [['2450']]),
  q('changed-06', 'changed', 'Which bank holds the Heron Cabin operating account?', [['northfield']]),
  q('changed-07', 'changed', 'What school does Felix go to?', [['eastbrook middle']]),
  q('changed-08', 'changed', 'Who services the hot tub at the cabin?', [['summit']]),

  // split: the answer is spread over two or more records.
  q('split-01', 'split', 'What are my dogs\' names?', [['biscuit'], ['pepper']]),
  q('split-02', 'split', 'Which properties does Quarry Road Partners own?', [['12 quarry'], ['8 alder']]),
  q('split-03', 'split', 'What are my kids into after school?', [['cello'], ['soccer']]),
  q('split-04', 'split', 'Which boats run the main route?', [['osprey'], ['tern']]),
  q('split-05', 'split', 'Which work credentials do I have to keep current?', [['master', '100-ton', '100 ton'], ['twic']]),
  q('split-06', 'split', 'Who are all the tenants in my rentals?', [['abara'], ['reddy']]),
  q('split-07', 'split', 'Which insurance companies do I have policies with?', [['alder mutual'], ['keystone']]),
  q('split-08', 'split', 'Which vendors look after Heron Cabin?', [['marisol', 'pena'], ['hale'], ['dunmore']]),

  // absent: the fact is nowhere. The right answer is to say so.
  absent('absent-01', 'What\'s my favorite food?'),
  absent('absent-02', 'When is Riley\'s birthday?'),
  absent('absent-03', 'When does my passport expire?'),
  absent('absent-04', 'How much is the property tax on Heron Cabin?'),
  absent('absent-05', 'What\'s Dana Okafor\'s phone number?'),
  absent('absent-06', 'Who is Felix\'s teacher this year?'),
  absent('absent-07', 'What\'s the license plate on my car?'),
  absent('absent-08', 'What does Tom Brandt charge per hour?'),
  absent('absent-09', 'What\'s the Wi-Fi password at the cabin?'),
  absent('absent-10', 'Which frequent flyer program am I in?'),

  // trap: the confirmed record says the fact is disputed and to ask.
  flag('trap-01', 'trap', 'Which entity holds my half of Quarry Road Partners?', ['larkspur holdings', 'larkspur cabins']),
  flag('trap-02', 'trap', 'Is the hot tub covered by the cabin\'s insurance?', []),
  // conflict: two records disagree and nothing says which is right.
  flag('conflict-01', 'conflict', 'How much is the security deposit on 8 Alder Lane upstairs?', ['1700', '2000']),
  flag('conflict-02', 'conflict', 'Who is on call Christmas Day?', []),

  // own_stale: the chat app's own notes are out of date; the record is right.
  q('own-stale-01', 'own_stale', 'Which gym do I go to?', [['harbor athletic']], { must_not: ['ironworks'] }),
  q('own-stale-02', 'own_stale', 'Where does Riley work?', [['eastbrook general']], { must_not: ['brendan'] }),
  q('own-stale-03', 'own_stale', 'What\'s the base nightly rate at Heron Cabin?', [['285']], { must_not: ['240'] }),
  q('own-stale-04', 'own_stale', 'What team does Felix play for?', [['otters']], { must_not: ['comets'] }),
  q('own-stale-05', 'own_stale', 'When is the weekly ops meeting?', [['tuesday', 'tuesdays']], { must_not: ['monday', 'mondays'] }),
  q('own-stale-06', 'own_stale', 'What\'s my coffee order?', [['flat white']], { must_not: ['americano'] }),

  // own_only: only the chat app's own notes have it.
  q('own-only-01', 'own_only', 'What\'s my favorite band?', [['low tides']]),
  q('own-only-02', 'own_only', 'What race am I training for?', [['10k']]),
  q('own-only-03', 'own_only', 'What laptop do I use?', [['macbook']]),
  q('own-only-04', 'own_only', 'What do I mostly read?', [['maritime history']]),

  // project: the answer is in a project document.
  q('project-01', 'project', 'Where does the ferry crew app stand?', [['build 14']]),
  q('project-02', 'project', 'What\'s the next step on the Heron Cabin winter campaign?', [['wood stove']]),
  q('project-03', 'project', 'Did the Quarry Road refinance close, and when?', [['september 18', 'sept 18', 'sep 18', '9/18', '2026-09-18', '18 september', 'september 18th']]),
  q('project-04', 'project', 'What milestone is Corgi Dash on?', [['leaderboard']]),
  q('project-05', 'project', 'What is the winter schedule project waiting on?', [['union']]),
  q('project-06', 'project', 'What is the ferry crew app built with?', [['react native'], ['supabase']]),

  // same_name: two people called Dana.
  q('name-01', 'same_name', 'What is Dana\'s job at the ferry?', [['finance director']]),
  q('name-02', 'same_name', 'Which Dana takes the tenant calls?', [['okafor']]),
  q('name-03', 'same_name', 'Who signs off on the ferry\'s operating budget?', [['reyes']]),
  q('name-04', 'same_name', 'Is the Dana at the ferry the same person as my rental partner?', [['different', 'not the same', 'two people', 'separate people', 'two different']]),
];
