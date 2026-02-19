import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { FactoryConsole } from '@gitroom/frontend/components/content-factory/factory.console';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Logs`,
  description: '',
};

export default async function Page() {
  return (
    <FactoryConsole
      view="logs"
      title="链路日志"
      subtitle="检索 trace_id 并定位采集、生成、发布错误"
      badge="LOGS"
    />
  );
}
