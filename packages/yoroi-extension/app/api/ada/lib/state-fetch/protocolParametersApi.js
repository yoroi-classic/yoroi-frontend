// @flow

import axios from 'axios';
import type { ProtocolParameters } from './protocolParameters';

export default class ProtocolParametersApi {
  apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  async getParameters(): Promise<ProtocolParameters> {
    const { data } = await axios.get('/protocolparameters', { baseURL: this.apiUrl });
    return data;
  }

  async getCostModels(): Promise<string> {
    const { data } = await axios.get('/protocolparameters/costmodels', { baseURL: this.apiUrl });
    return data;
  }
}
