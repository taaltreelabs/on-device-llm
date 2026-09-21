import { NativeModule, requireNativeModule } from 'expo';

declare class OnDeviceLlmModule extends NativeModule<{}> {}

export default requireNativeModule<OnDeviceLlmModule>('OnDeviceLlm');
