import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { FactoryConsole } from '@gitroom/frontend/components/content-factory/factory.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Dashboard`,
  description: '',
};

export default async function Page() {
  return (
    <FactoryConsole
      view="dashboard"
      title="内容工厂总览"
      subtitle="采集-理解-生成-审核-发布 全链路监控"
      badge="V1"
    />
  );
}
