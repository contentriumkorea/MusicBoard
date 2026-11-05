import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { App } from './App';
import { Mini } from './Mini';
import './styles.css';
import { initializeNativeBridge,notifyFrontendReady } from './native';
async function bootstrap(){
  await initializeNativeBridge();
  flushSync(()=>createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('mini')?<Mini/>:<App/>));
  await notifyFrontendReady();
}
void bootstrap().catch(()=>{
  const root=document.getElementById('root');
  if(root&&!root.hasChildNodes())root.textContent='PulseDeck를 시작하지 못했습니다. 앱을 다시 실행해주세요.';
  console.error('PulseDeck initialization failed');
});
