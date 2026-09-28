// Starter diagrams that follow well-known notations. Written for this project (not copied from anywhere),
// each with a short guide the agent follows when it builds on or restructures toward the template.
import type { AIShape } from "./session.js";
import { DRAWIO_TEMPLATES } from "./templates-drawio.js";

export interface Template {
  id: string;
  name: string;
  kind: string;
  description: string;
  /** conventions the agent should keep to; sent with turns on a tab that uses this template */
  guide: string;
  /** where the notation comes from, for the curious */
  source: string;
  /** a canonical worked example of the notation, as compact text for the agent to compare against */
  example?: string;
  shapes: AIShape[];
}

const box = (id: string, x: number, y: number, label: string, reason?: string, extra: Partial<AIShape> = {}): AIShape =>
  ({ id, type: "rectangle", x, y, width: 180, height: 80, label, ...(reason && { reason }), ...extra });
const oval = (id: string, x: number, y: number, label: string, reason?: string, extra: Partial<AIShape> = {}): AIShape =>
  ({ id, type: "ellipse", x, y, width: 180, height: 80, label, ...(reason && { reason }), ...extra });
const arrow = (id: string, from: string, to: string, label?: string): AIShape =>
  ({ id, type: "arrow", start: { id: from }, end: { id: to }, ...(label && { label }) });
const frame = (id: string, x: number, y: number, width: number, height: number, label: string, reason?: string): AIShape =>
  ({ id, type: "frame", x, y, width, height, label, ...(reason && { reason }) });

// Reference: the "Big Bank plc" model that ships with Structurizr (structurizr/java, Apache-2.0), the C4 model's own worked example.
const BIG_BANK_CONTEXT =
  "Big Bank plc, System Context (canonical C4 example from Structurizr). People: Personal Banking Customer; Customer Service Staff; Back Office Staff. " +
  "System in focus: Internet Banking System. External systems: Mainframe Banking System, E-mail System, ATM. Relationships: " +
  "Customer -> Internet Banking System 'Views account balances, and makes payments using'; Internet Banking System -> Mainframe 'Gets account information from, and makes payments using'; " +
  "Internet Banking System -> E-mail System 'Sends e-mail using'; E-mail System -> Customer 'Sends e-mails to'; Customer -> Customer Service Staff 'Asks questions to [Telephone]'; " +
  "Customer Service Staff -> Mainframe 'Uses'; Customer -> ATM 'Withdraws cash using'; ATM -> Mainframe 'Uses'; Back Office Staff -> Mainframe 'Uses'.";
const BIG_BANK_CONTAINERS =
  "Big Bank plc, Containers of the Internet Banking System (canonical C4 example from Structurizr). Containers: " +
  "Web Application [Java and Spring MVC] 'Delivers the static content and the Internet banking single page application'; " +
  "Single-Page Application [JavaScript and Angular] 'Provides all of the Internet banking functionality to customers via their web browser'; " +
  "Mobile App [Xamarin] 'Provides a limited subset of the Internet banking functionality'; API Application [Java and Spring MVC] 'Provides Internet banking functionality via a JSON/HTTPS API'; " +
  "Database [Oracle Database Schema] 'Stores user registration information, hashed authentication credentials, access logs, etc.'. Outside the boundary: Personal Banking Customer, Mainframe Banking System, E-mail System. " +
  "Relationships: Customer -> Web Application 'Visits bigbank.com/ib using [HTTPS]'; Customer -> Single-Page Application and Mobile App 'Views account balances, and makes payments using'; " +
  "Web Application -> Single-Page Application 'Delivers to the customer web browser'; Single-Page Application and Mobile App -> API Application 'Makes API calls to [JSON/HTTPS]'; " +
  "API Application -> Database 'Reads from and writes to [JDBC]'; API Application -> Mainframe 'Makes API calls to [XML/HTTPS]'; API Application -> E-mail System 'Sends e-mail using'.";

const FOCUS = { backgroundColor: "#dbe4ff" };
const EXTERNAL = { backgroundColor: "#e9ecef" };

export const TEMPLATES: Template[] = [
  {
    id: "c4-context", name: "C4 · System context", kind: "Architecture",
    description: "Your system as one box, with the people and external systems around it.",
    source: "C4 model, level 1 (c4model.com); example: Structurizr Big Bank plc (Apache-2.0)",
    example: BIG_BANK_CONTEXT,
    guide: "C4 level 1 (System Context): one box for the system in focus, the people/roles who use it, and the external systems it depends on. " +
      "No technologies or internals at this level. Every arrow is a one-way, labeled relationship ('Uses', 'Sends email via').",
    shapes: [
      oval("person", 300, 0, "Customer\n[Person]", "Replace with your real user roles; add one per role", FOCUS),
      box("system", 280, 220, "Your System\n[Software System]", "The system in focus; keep internals out of this view", { ...FOCUS, width: 220, height: 100 }),
      box("ext1", 0, 460, "Email Service\n[External System]", "Systems you depend on but don't own", EXTERNAL),
      box("ext2", 600, 460, "Payment Provider\n[External System]", undefined, EXTERNAL),
      arrow("r1", "person", "system", "Uses"),
      arrow("r2", "system", "ext1", "Sends email via"),
      arrow("r3", "system", "ext2", "Takes payments via"),
    ],
  },
  {
    id: "c4-container", name: "C4 · Containers", kind: "Architecture",
    description: "Zoom into one system: apps, APIs, databases and queues inside its boundary.",
    source: "C4 model, level 2 (c4model.com); example: Structurizr Big Bank plc (Apache-2.0)",
    example: BIG_BANK_CONTAINERS,
    guide: "C4 level 2 (Container): zoom into one system. Each box is a separately running/deployable unit (web app, API, database, queue, worker) " +
      "labeled 'Name [Technology]'. People and external systems stay outside the system-boundary frame. Label arrows with intent and protocol ('Reads/writes [SQL]').",
    shapes: [
      oval("user", 400, 0, "User\n[Person]", undefined, FOCUS),
      frame("boundary", 0, 160, 980, 420, "Your System [boundary]", "Everything inside is part of this one system"),
      box("web", 40, 240, "Web App\n[React]", "Each box runs separately: name [technology]"),
      box("api", 400, 240, "API\n[Node.js]"),
      box("db", 760, 240, "Database\n[PostgreSQL]"),
      box("worker", 400, 450, "Worker\n[Queue consumer]"),
      box("ext", 1120, 450, "External Service\n[Software System]", "Outside the boundary: systems you call", EXTERNAL),
      arrow("r1", "user", "web", "Uses [HTTPS]"),
      arrow("r2", "web", "api", "Calls [JSON/HTTPS]"),
      arrow("r3", "api", "db", "Reads/writes [SQL]"),
      arrow("r4", "api", "worker", "Enqueues jobs"),
      arrow("r5", "api", "ext", "Calls [HTTPS]"),
    ],
  },
  {
    id: "three-tier", name: "Three-tier web app", kind: "Deployment",
    description: "Edge, application and data tiers with public/private separation in a VPC.",
    source: "AWS Well-Architected three-tier reference architecture",
    guide: "Three-tier web application: presentation/edge, application and data tiers. Only edge components (CDN, load balancer) are public; " +
      "app and data tiers sit in private subnets inside the VPC frame. Put scaling and redundancy in labels (auto-scaling group, Multi-AZ, read replica).",
    shapes: [
      oval("users", 0, 200, "Users"),
      box("cdn", 240, 200, "CDN / DNS", "Edge: caches static content, terminates TLS"),
      frame("vpc", 470, 20, 760, 460, "VPC", "Public edge vs private app and data subnets"),
      box("lb", 500, 200, "Load Balancer\n[public subnet]"),
      box("app", 760, 200, "App Servers\n[private, auto-scaling]", "Stateless so the group can scale out"),
      box("db", 1020, 90, "Database\n[private, Multi-AZ]", "Primary + standby in another AZ"),
      box("cache", 1020, 330, "Cache\n[private]"),
      arrow("r1", "users", "cdn", "HTTPS"),
      arrow("r2", "cdn", "lb", "HTTPS"),
      arrow("r3", "lb", "app"),
      arrow("r4", "app", "db", "SQL"),
      arrow("r5", "app", "cache"),
    ],
  },
  {
    id: "microservices", name: "Microservices + gateway", kind: "Architecture",
    description: "API gateway in front of services that each own their data.",
    source: "Common microservices reference pattern (API gateway, database per service)",
    guide: "Microservices: an API gateway fronts independently deployable services; each service owns its own data store (no shared database). " +
      "Show where calls are synchronous (REST/gRPC) and where they're asynchronous events, and which service owns which data.",
    shapes: [
      oval("clients", 0, 200, "Clients"),
      box("gw", 250, 200, "API Gateway", "Auth, routing, rate limiting in one place"),
      box("s1", 540, 40, "Users Service"),
      box("s2", 540, 200, "Orders Service"),
      box("s3", 540, 360, "Catalog Service"),
      box("d1", 830, 40, "Users DB", "Database per service: nobody else reads it directly", EXTERNAL),
      box("d2", 830, 200, "Orders DB", undefined, EXTERNAL),
      box("d3", 830, 360, "Catalog DB", undefined, EXTERNAL),
      box("bus", 540, 540, "Event Bus", "Async integration between services"),
      arrow("r1", "clients", "gw", "HTTPS"),
      arrow("r2", "gw", "s1", "REST"), arrow("r3", "gw", "s2", "REST"), arrow("r4", "gw", "s3", "REST"),
      arrow("r5", "s1", "d1"), arrow("r6", "s2", "d2"), arrow("r7", "s3", "d3"),
      arrow("r8", "s2", "bus", "OrderPlaced"),
    ],
  },
  {
    id: "event-driven", name: "Event-driven (pub/sub)", kind: "Data flow",
    description: "Producers publish events to a broker; consumers subscribe; failures go to a DLQ.",
    source: "Publish-subscribe / event-driven architecture patterns (Enterprise Integration Patterns)",
    guide: "Event-driven: producers publish named, past-tense events (OrderPlaced) to a broker/topic and don't know their consumers. " +
      "Label arrows with event names; show consumer groups, retries and a dead-letter queue; note ordering and delivery guarantees in reasons.",
    shapes: [
      box("p1", 0, 0, "Order Service\n[producer]"),
      box("p2", 0, 240, "Payment Service\n[producer]"),
      box("broker", 300, 120, "Event Bus / Topic", "At-least-once delivery: consumers must be idempotent", { width: 200 }),
      box("c1", 640, 0, "Email Consumer"),
      box("c2", 640, 240, "Analytics Consumer"),
      box("dlq", 640, 460, "Dead-letter Queue", "Where events land after retries run out", EXTERNAL),
      arrow("r1", "p1", "broker", "OrderPlaced"),
      arrow("r2", "p2", "broker", "PaymentCaptured"),
      arrow("r3", "broker", "c1", "subscribe"),
      arrow("r4", "broker", "c2", "subscribe"),
      arrow("r5", "c1", "dlq", "after retries"),
    ],
  },
  {
    id: "dfd-threat", name: "Data flow + trust boundaries", kind: "Data flow",
    description: "Threat-modeling DFD: entities, processes, data stores and trust boundaries.",
    source: "Data flow diagrams for threat modeling (OWASP Threat Modeling, Microsoft STRIDE)",
    guide: "Data flow diagram for threat modeling: external entities (rectangles), processes (ellipses), data stores, and labeled data flows. " +
      "Draw a trust boundary (frame) wherever data crosses a privilege or network level; every flow crossing a boundary is reviewed for threats (STRIDE).",
    shapes: [
      box("user", 0, 140, "User\n[external entity]", "Anything outside your control", EXTERNAL),
      frame("tb", 260, 0, 700, 380, "Trust boundary: internet → service", "Flows crossing this line get a threat review"),
      oval("web", 300, 140, "Web App\n[process]"),
      oval("auth", 680, 40, "Auth Service\n[process]"),
      box("store", 680, 240, "User DB\n[data store]", "Sensitive data at rest: note encryption and access"),
      arrow("r1", "user", "web", "credentials"),
      arrow("r2", "web", "auth", "auth request"),
      arrow("r3", "auth", "store", "read user record"),
    ],
  },
  {
    id: "sequence", name: "Sequence diagram", kind: "Flow",
    description: "Participants across the top, numbered messages down their lifelines.",
    source: "UML 2 sequence diagrams",
    guide: "UML sequence diagram: participants across the top, time flows down their lifelines. Number messages in order, " +
      "use arrows left-to-right for calls and right-to-left for replies, and keep one scenario per diagram (happy path or one specific failure).",
    shapes: [
      box("client", 0, 0, "Client", undefined, { width: 140, height: 60 }),
      box("api", 280, 0, "API", undefined, { width: 140, height: 60 }),
      box("db", 560, 0, "Database", undefined, { width: 140, height: 60 }),
      { id: "l1", type: "line", x: 70, y: 70, width: 0, height: 380 },
      { id: "l2", type: "line", x: 350, y: 70, width: 0, height: 380 },
      { id: "l3", type: "line", x: 630, y: 70, width: 0, height: 380 },
      { id: "m1", type: "arrow", x: 75, y: 130, width: 270, height: 0, label: "1. POST /orders" },
      { id: "m2", type: "arrow", x: 355, y: 200, width: 270, height: 0, label: "2. INSERT order" },
      { id: "m3", type: "arrow", x: 625, y: 270, width: -270, height: 0, label: "3. ok" },
      { id: "m4", type: "arrow", x: 345, y: 340, width: -270, height: 0, label: "4. 201 Created" },
    ],
  },
  {
    id: "kubernetes", name: "Kubernetes deployment", kind: "Deployment",
    description: "Ingress → Service → Deployment inside a cluster, with config, autoscaling and a managed DB.",
    source: "Kubernetes documentation concepts (Ingress, Service, Deployment, HPA)",
    guide: "Kubernetes deployment: the cluster (or namespace) is a frame; traffic enters through Ingress → Service → Deployment pods. " +
      "Show replica counts, autoscaling (HPA), ConfigMaps/Secrets, and managed services outside the cluster. Label arrows with ports/protocols where it matters.",
    shapes: [
      oval("users", 0, 0, "Users"),
      box("ing", 0, 200, "Ingress\n[TLS, routing]"),
      frame("cluster", 240, 120, 800, 380, "Cluster / namespace", "Everything Kubernetes manages"),
      box("svc", 280, 200, "Service\n[ClusterIP]"),
      box("dep", 560, 200, "Deployment\n[3 replicas]", "Pods are stateless; state lives in the managed DB"),
      box("cfg", 280, 380, "ConfigMap / Secret"),
      box("hpa", 820, 380, "HPA\n[autoscaler]"),
      box("db", 1140, 200, "Managed DB", "Outside the cluster: managed service", EXTERNAL),
      arrow("r1", "users", "ing", "HTTPS"),
      arrow("r2", "ing", "svc", "routes"),
      arrow("r3", "svc", "dep", "selects pods"),
      arrow("r4", "dep", "cfg", "mounts"),
      arrow("r5", "hpa", "dep", "scales"),
      arrow("r6", "dep", "db", "TCP 5432"),
    ],
  },
  {
    id: "flowchart", name: "Flowchart", kind: "Flow",
    description: "Start/end, process steps and yes/no decisions, top to bottom.",
    source: "ISO 5807 flowchart symbols",
    guide: "Flowchart (ISO 5807 symbols): ellipse = start/end, rectangle = process step, diamond = decision with labeled yes/no exits. " +
      "Flow top-to-bottom; every decision has clearly labeled exits and every path reaches an end.",
    shapes: [
      oval("start", 0, 0, "Start", undefined, { width: 160, height: 70 }),
      box("step", 0, 170, "Process step"),
      { id: "decide", type: "diamond", x: -10, y: 340, width: 200, height: 120, label: "Condition?" },
      box("yes", 320, 360, "Handle yes"),
      oval("end", 0, 580, "End", undefined, { width: 160, height: 70 }),
      arrow("r1", "start", "step"),
      arrow("r2", "step", "decide"),
      arrow("r3", "decide", "yes", "yes"),
      arrow("r4", "decide", "end", "no"),
      arrow("r5", "yes", "end"),
    ],
  },
];

TEMPLATES.push(...DRAWIO_TEMPLATES);

export const findTemplate = (ref?: string) => {
  const r = ref?.trim().toLowerCase();
  return r ? TEMPLATES.find((t) => t.id === r || t.name.toLowerCase() === r) : undefined;
};

/** Template shapes with ids made unique for a tab (ids are session-wide). */
export function scaffold(t: Template, prefix: string): AIShape[] {
  const p = (id: string) => `${prefix}${id}`;
  return t.shapes.map((s) => ({
    ...s, id: p(s.id),
    ...(s.start && { start: { id: p(s.start.id) } }),
    ...(s.end && { end: { id: p(s.end.id) } }),
    ...(s.children && { children: s.children.map(p) }),
  }));
}
