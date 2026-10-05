import type { Endpoint, EndpointKind } from '../model/index.js';

export interface EndpointInit {
  method: string;
  origin: string;
  path: string;
  operationName?: string;
  kind: EndpointKind;
}

export class EndpointFactory {
  static key(method: string, origin: string, path: string, operationName?: string): string {
    return `${method} ${origin}${path}${operationName ? `#${operationName}` : ''}`;
  }

  static blank(init: EndpointInit): Endpoint {
    const key = EndpointFactory.key(init.method, init.origin, init.path, init.operationName);
    return {
      id: key,
      name: key,
      key,
      method: init.method,
      origin: init.origin,
      path: init.path,
      ...(init.operationName ? { operationName: init.operationName } : {}),
      kind: init.kind,
      firstParty: false,
      pathParams: [],
      queryParams: [],
      headerParams: [],
      responses: [],
      auth: { cookies: [], headers: [], bearer: false, csrf: [] },
      resourceTypes: [],
      samples: [],
      count: 0,
    };
  }

  static normalize(endpoint: Endpoint): Endpoint {
    return {
      id: endpoint.id,
      name: endpoint.name,
      key: endpoint.key,
      method: endpoint.method,
      origin: endpoint.origin,
      path: endpoint.path,
      ...(endpoint.operationName !== undefined ? { operationName: endpoint.operationName } : {}),
      kind: endpoint.kind,
      firstParty: endpoint.firstParty,
      pathParams: endpoint.pathParams,
      queryParams: endpoint.queryParams,
      headerParams: endpoint.headerParams,
      ...(endpoint.requestBody !== undefined ? { requestBody: endpoint.requestBody } : {}),
      responses: endpoint.responses,
      auth: endpoint.auth,
      ...(endpoint.form !== undefined ? { form: endpoint.form } : {}),
      resourceTypes: endpoint.resourceTypes,
      samples: endpoint.samples,
      count: endpoint.count,
    };
  }
}
