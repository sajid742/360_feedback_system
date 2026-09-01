import { apiClient, type Paginated } from '@/lib/api-client';

export type QuestionType = 'rating' | 'yes_no' | 'multiple_choice' | 'text' | 'numeric';

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  category: string | null;
  competencyId: string | null;
  isMandatory: boolean;
  weight: number;
  status: string;
}

export interface TemplateSummary {
  id: string;
  name: string;
  status: string;
  version: number;
  sections: number;
  updatedAt: string;
}

export interface SectionQuestion {
  id: string;
  questionId: string;
  text: string;
  type: QuestionType;
  sortOrder: number;
}

export interface TemplateSection {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  questions: SectionQuestion[];
}

export interface TemplateDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  sections: TemplateSection[];
}

export const questionnaireApi = {
  listQuestions: (search: string): Promise<Paginated<Question>> =>
    apiClient.get('/questionnaire/questions', { search, page: 1, pageSize: 100 }),
  createQuestion: (input: {
    text: string;
    type: QuestionType;
    category?: string;
    isMandatory?: boolean;
    /**
     * The competency this question measures. This link is the ONLY thing that puts a
     * question's answers into a competency score, a coverage row or a heatmap cell.
     * Without it the answer still counts towards the quadrant score but appears in no
     * competency report.
     */
    competencyId?: string;
  }): Promise<Question> => apiClient.post('/questionnaire/questions', input),
  /** `competencyId: null` clears the link; omitting it leaves the existing one alone. */
  updateQuestion: (
    id: string,
    input: {
      text?: string;
      type?: QuestionType;
      category?: string;
      isMandatory?: boolean;
      competencyId?: string | null;
    },
  ): Promise<Question> => apiClient.put(`/questionnaire/questions/${id}`, input),
  deleteQuestion: (id: string): Promise<void> => apiClient.delete(`/questionnaire/questions/${id}`),

  listTemplates: (): Promise<TemplateSummary[]> => apiClient.get('/questionnaire/templates'),
  getTemplate: (id: string): Promise<TemplateDetail> => apiClient.get(`/questionnaire/templates/${id}`),
  createTemplate: (input: { name: string; description?: string }): Promise<TemplateDetail> =>
    apiClient.post('/questionnaire/templates', input),
  addSection: (id: string, title: string): Promise<TemplateDetail> =>
    apiClient.post(`/questionnaire/templates/${id}/sections`, { title }),
  removeSection: (id: string, sectionId: string): Promise<TemplateDetail> =>
    apiClient.delete(`/questionnaire/templates/${id}/sections/${sectionId}`),
  addQuestion: (id: string, sectionId: string, questionId: string): Promise<TemplateDetail> =>
    apiClient.post(`/questionnaire/templates/${id}/sections/${sectionId}/questions`, { questionId }),
  removeSectionQuestion: (id: string, sectionQuestionId: string): Promise<TemplateDetail> =>
    apiClient.delete(`/questionnaire/templates/${id}/section-questions/${sectionQuestionId}`),
  publish: (id: string): Promise<TemplateDetail> => apiClient.post(`/questionnaire/templates/${id}/publish`),
  clone: (id: string): Promise<TemplateDetail> => apiClient.post(`/questionnaire/templates/${id}/clone`),
};
