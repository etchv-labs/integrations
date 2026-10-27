import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from "n8n-workflow";

export class EtchvApi implements ICredentialType {
  name = "etchvApi";
  displayName = "Etchv API";
  documentationUrl = "https://etchv.com/docs/integrations/n8n";
  properties: INodeProperties[] = [{ displayName: "API Key", name: "apiKey", type: "string", typeOptions: { password: true }, default: "", required: true }];
  authenticate: IAuthenticateGeneric = { type: "generic", properties: { headers: { "X-API-Key": "={{$credentials.apiKey}}" } } };
  test: ICredentialTestRequest = { request: { baseURL: "https://api.etchv.com", url: "/auth/api-key" } };
}
