export function briefQuestionKey(question: string) {
  return question.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
