import { Injectable } from '@angular/core';
import {
  AdminScenarioConfig,
  AdminTrainingConfig,
  EMPTY_ADMIN_CONFIG,
  ScenarioFlowData
} from '../types/training-config';

@Injectable({ providedIn: 'root' })
export class AdminConfigService {
  private readonly API_BASE = 'http://127.0.0.1:8000';

  async getConfig(): Promise<AdminTrainingConfig> {
    try {
      const res = await fetch(`${this.API_BASE}/api/admin/config`);
      if (!res.ok) {
        throw new Error('Failed to load admin config');
      }
      const data = await res.json();
      return this.normalizeConfig(data);
    } catch (err) {
      console.error('Admin config fetch failed:', err);
      return { ...EMPTY_ADMIN_CONFIG };
    }
  }

  async saveConfig(config: AdminTrainingConfig): Promise<AdminTrainingConfig> {
    try {
      const res = await fetch(`${this.API_BASE}/api/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (!res.ok) {
        throw new Error('Failed to save admin config');
      }
      const data = await res.json();
      return this.normalizeConfig(data);
    } catch (err) {
      console.error('Admin config save failed:', err);
      throw err;
    }
  }

  private normalizeConfig(raw: any): AdminTrainingConfig {
    if (!raw || typeof raw !== 'object') {
      return { ...EMPTY_ADMIN_CONFIG };
    }
    const scenarios = Array.isArray(raw.mandatoryScenarios) ? raw.mandatoryScenarios : [];
    const normalizedScenarios: AdminScenarioConfig[] = scenarios
      .map((entry: any) => this.normalizeScenario(entry))
      .filter(
        (entry: AdminScenarioConfig | null | undefined): entry is AdminScenarioConfig =>
          !!entry?.question
      );

    const minimums = raw.minimums || {};
    const normalizeMinimum = (value: any) => {
      const num = Number(value);
      if (Number.isNaN(num) || num < 0) return 0;
      return Math.floor(num);
    };

    return {
      mandatoryScenarios: normalizedScenarios,
      minimums: {
        knowledge: normalizeMinimum(minimums.knowledge),
        quiz: normalizeMinimum(minimums.quiz),
        scenario: normalizeMinimum(minimums.scenario)
      }
    };
  }

  private normalizeScenario(entry: any): AdminScenarioConfig | null {
    if (!entry || typeof entry !== 'object') return null;
    const question = `${entry.question || ''}`.trim();
    if (!question) return null;
    const id = `${entry.id || crypto.randomUUID?.() || Date.now()}`;
    const summary = `${entry.summary || ''}`.trim();
    const title = `${entry.title || ''}`.trim();
    const preferenceValue = `${entry.preference || 'classic'}`.trim().toLowerCase();
    const preference = preferenceValue === 'tailored' ? 'tailored' : 'classic';
    const filters = this.normalizeFilters(entry.filters);
    return {
      id,
      title,
      question,
      summary,
      preference,
      ...(filters ? { filters } : {})
    };
  }

  private normalizeFilters(filters: any): ScenarioFlowData | null {
    if (!filters || typeof filters !== 'object') return null;
    const entries: ScenarioFlowData = {};
    (['intent', 'industry', 'situation', 'objection', 'audience', 'summary'] as const).forEach(key => {
      const value = filters[key];
      if (value === undefined || value === null) return;
      const text = `${value}`.trim();
      if (!text) return;
      entries[key] = text;
    });
    return Object.keys(entries).length ? entries : null;
  }
}

