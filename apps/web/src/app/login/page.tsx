import LoginClient from "./LoginClient"

type LoginPageProps = {
  searchParams?: {
    redirectTo?: string | string[]
  }
}

export default function LoginPage({ searchParams }: LoginPageProps) {
  const redirectTo = typeof searchParams?.redirectTo === "string" ? searchParams.redirectTo : "/"

  return (
    <LoginClient redirectTo={redirectTo} />
  )
}
