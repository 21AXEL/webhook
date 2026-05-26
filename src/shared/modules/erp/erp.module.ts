import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ErpService } from "./erp.service";
import configuration from "@config/configuration";
import { postgresqlProvider } from "@database/postgresql.provider";

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      envFilePath: ".env",
    }),
  ],
  providers: [postgresqlProvider, ErpService],
  exports: [ErpService],
})
export class ErpModule {}
