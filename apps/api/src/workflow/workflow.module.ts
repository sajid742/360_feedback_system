import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { DefinitionService } from './services/definition.service';
import { EngineService } from './services/engine.service';

/** Generic workflow engine. EngineService is exported so domain modules (e.g.
 *  Appraisal) can start instances against their entities. */
@Module({
  controllers: [WorkflowController],
  providers: [DefinitionService, EngineService],
  exports: [EngineService],
})
export class WorkflowModule {}
