import { normalizeUrlForTelemetry } from './normalize-url';

export interface RequestRecord {
  requestId: string;
  url: string;
  normalizedHostname: string;
  resourceType: string;
  initiator?: string;
  timestamp: number;
  status: 'pending' | 'completed' | 'blocked' | 'error';
  errorDetails?: string;
}

export interface NavigationRequestGraph {
  navigationId: string;
  tabId: number;
  totalRequests: number;
  blockedRequestsCount: number;
  failedRequestsCount: number;
  domainCounts: Map<string, number>;
  blockedDomains: Set<string>;
  recentRequests: RequestRecord[];
}

export class RequestGraphManager {
  // Key: navigationId -> NavigationRequestGraph
  private graphs = new Map<string, NavigationRequestGraph>();

  public getOrCreateGraph(navigationId: string, tabId: number): NavigationRequestGraph {
    let graph = this.graphs.get(navigationId);
    if (!graph) {
      graph = {
        navigationId,
        tabId,
        totalRequests: 0,
        blockedRequestsCount: 0,
        failedRequestsCount: 0,
        domainCounts: new Map(),
        blockedDomains: new Set(),
        recentRequests: [],
      };
      this.graphs.set(navigationId, graph);
    }
    return graph;
  }

  public recordRequest(
    navigationId: string,
    tabId: number,
    requestId: string,
    url: string,
    resourceType: string,
    initiator?: string
  ): void {
    const graph = this.getOrCreateGraph(navigationId, tabId);
    const norm = normalizeUrlForTelemetry(url);

    graph.totalRequests++;
    const currentDomainCount = graph.domainCounts.get(norm.hostname) || 0;
    graph.domainCounts.set(norm.hostname, currentDomainCount + 1);

    const record: RequestRecord = {
      requestId,
      url: `${norm.origin}${norm.coarsePath}`,
      normalizedHostname: norm.hostname,
      resourceType,
      initiator,
      timestamp: Date.now(),
      status: 'pending',
    };

    graph.recentRequests.push(record);
    if (graph.recentRequests.length > 100) {
      graph.recentRequests.shift();
    }
  }

  public recordBlockedOrError(
    navigationId: string,
    tabId: number,
    url: string,
    isBlockedByClient: boolean
  ): void {
    const graph = this.getOrCreateGraph(navigationId, tabId);
    const norm = normalizeUrlForTelemetry(url);

    if (isBlockedByClient) {
      graph.blockedRequestsCount++;
      graph.blockedDomains.add(norm.hostname);
    } else {
      graph.failedRequestsCount++;
    }
  }

  public recordCompleted(navigationId: string, requestId: string): void {
    const graph = this.graphs.get(navigationId);
    const record = graph?.recentRequests.find((item) => item.requestId === requestId);
    if (record) record.status = 'completed';
  }

  public cleanupGraph(navigationId: string): void {
    this.graphs.delete(navigationId);
  }

  public getGraph(navigationId: string): NavigationRequestGraph | undefined {
    return this.graphs.get(navigationId);
  }
}
