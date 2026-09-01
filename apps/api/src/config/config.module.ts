import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigurationService } from './services/configuration.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { RatingScaleService } from './services/rating-scale.service';

@Module({
  controllers: [ConfigController],
  providers: [ConfigurationService, FeatureFlagService, RatingScaleService],
  exports: [ConfigurationService, RatingScaleService, FeatureFlagService],
})
export class ConfigModule {}
