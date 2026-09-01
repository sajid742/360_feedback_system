import { Module } from '@nestjs/common';
import { QuestionnaireController } from './questionnaire.controller';
import { QuestionService } from './services/question.service';
import { TemplateService } from './services/template.service';
import { RubricService } from './services/rubric.service';

@Module({
  controllers: [QuestionnaireController],
  providers: [QuestionService, TemplateService, RubricService],
  exports: [TemplateService],
})
export class QuestionnaireModule {}
