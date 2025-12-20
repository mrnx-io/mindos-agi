import LoginClient from "./LoginClient"

type LoginPageProps = {
  searchParams?: Promise<{
    redirectTo?: string | string[]
  }>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = await searchParams
  const redirectTo =
    typeof resolvedSearchParams?.redirectTo === "string" ? resolvedSearchParams.redirectTo : "/"

  return (
    <LoginClient redirectTo={redirectTo} />
  )
}
