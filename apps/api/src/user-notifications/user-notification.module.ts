import { Module } from '@nestjs/common';
import { UserNotificationController } from './user-notification.controller';
import { UserNotificationService } from './user-notification.service';

@Module({
  controllers: [UserNotificationController],
  providers: [UserNotificationService],
  exports: [UserNotificationService],
})
export class UserNotificationModule {}
