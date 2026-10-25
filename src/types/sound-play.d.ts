declare module 'sound-play' {
  const sound: { play(file: string, volume?: number): Promise<void> };
  export default sound;
}
