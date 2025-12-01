export type ScenarioPreference = 'classic' | 'tailored';

export interface ScenarioFlowData {
  intent?: string;
  industry?: string;
  situation?: string;
  objection?: string;
  audience?: string;
  summary?: string;
}

export interface AdminScenarioConfig {
  id: string;
  title?: string;
  question: string;
  summary?: string;
  preference?: ScenarioPreference;
  filters?: ScenarioFlowData;
}

export interface CompletionMinimums {
  knowledge: number;
  quiz: number;
  scenario: number;
}

export interface AdminTrainingConfig {
  mandatoryScenarios: AdminScenarioConfig[];
  minimums: CompletionMinimums;
}

export const EMPTY_ADMIN_CONFIG: AdminTrainingConfig = {
  mandatoryScenarios: [],
  minimums: { knowledge: 0, quiz: 0, scenario: 0 }
};

